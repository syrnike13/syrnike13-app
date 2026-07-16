import { describe, expect, it, vi } from 'vitest'

import { HooksRuntimeController } from './hooks-runtime-controller'
import { NativeRuntimeRequestError } from './runtime-supervisor'

function supervisorStub() {
  let eventListener: ((event: unknown) => void) | null = null
  let stateListener: ((state: any) => void) | null = null
  const request = vi.fn(async () => undefined)
  return {
    supervisor: {
      onEvent(listener: (event: unknown) => void) {
        eventListener = listener
        return () => {}
      },
      onStateChange(listener: (state: any) => void) {
        stateListener = listener
        return () => {}
      },
      getSnapshot: () => ({ status: 'ready' }),
      request,
      shutdown: vi.fn(async () => undefined),
    } as any,
    request,
    event: (event: unknown) => eventListener?.(event),
    state: (state: unknown) => stateListener?.(state),
  }
}

describe('HooksRuntimeController', () => {
  it('reports each hooks runtime status independently', () => {
    const hotkey = supervisorStub()
    const overlay = supervisorStub()
    hotkey.supervisor.getSnapshot = () => ({ status: 'ready' })
    overlay.supervisor.getSnapshot = () => ({ status: 'degraded' })
    const controller = new HooksRuntimeController(
      hotkey.supervisor,
      overlay.supervisor,
    )

    expect(controller.getStatus('hotkey')).toBe('ready')
    expect(controller.getStatus('overlay')).toBe('degraded')
    expect(controller.getStatus()).toBe('degraded')
  })

  it('restarts and replays each hooks runtime independently', async () => {
    const hotkey = supervisorStub()
    const overlay = supervisorStub()
    const controller = new HooksRuntimeController(hotkey.supervisor, overlay.supervisor)
    vi.spyOn(controller, 'isAvailable').mockReturnValue(true)
    await controller.startHotkeys(vi.fn())
    await controller.startOverlay(vi.fn())
    hotkey.request.mockClear()
    overlay.request.mockClear()

    hotkey.state({ status: 'ready', restartCount: 1 })
    await vi.waitFor(() => expect(hotkey.request).toHaveBeenCalledWith({ type: 'startHotkeys' }, 5_000))
    expect(overlay.request).not.toHaveBeenCalled()

    hotkey.request.mockClear()
    overlay.state({ status: 'ready', restartCount: 1 })
    await vi.waitFor(() => expect(overlay.request).toHaveBeenCalledWith({ type: 'startOverlay' }, 5_000))
    expect(hotkey.request).not.toHaveBeenCalled()
  })

  it('allows retry after an initial start failure', async () => {
    const stub = supervisorStub()
    stub.request.mockRejectedValueOnce(new Error('failed'))
    const controller = new HooksRuntimeController(stub.supervisor)
    vi.spyOn(controller, 'isAvailable').mockReturnValue(true)
    const listener = vi.fn()

    await expect(controller.startHotkeys(listener)).rejects.toThrow('failed')
    await expect(controller.startHotkeys(listener)).resolves.toBeUndefined()
    expect(stub.request).toHaveBeenCalledTimes(2)
  })

  it('re-registers desired hooks after a host restart', async () => {
    const stub = supervisorStub()
    const controller = new HooksRuntimeController(stub.supervisor)
    vi.spyOn(controller, 'isAvailable').mockReturnValue(true)
    await controller.startHotkeys(vi.fn())
    await controller.startOverlay(vi.fn())
    stub.request.mockClear()

    stub.state({ status: 'ready', restartCount: 1 })
    await vi.waitFor(() => expect(stub.request).toHaveBeenCalledTimes(2))
    expect(stub.request).toHaveBeenCalledWith({ type: 'startHotkeys' }, 5_000)
    expect(stub.request).toHaveBeenCalledWith({ type: 'startOverlay' }, 5_000)
  })

  it('preserves desired hooks after a retryable runtime loss', async () => {
    const stub = supervisorStub()
    stub.request.mockRejectedValueOnce(
      new NativeRuntimeRequestError({
        code: 'runtime_lost',
        message: 'host exited',
        retryable: true,
      }),
    )
    const controller = new HooksRuntimeController(stub.supervisor)
    vi.spyOn(controller, 'isAvailable').mockReturnValue(true)
    await expect(controller.startHotkeys(vi.fn())).rejects.toThrow('host exited')
    stub.request.mockClear()

    stub.state({ status: 'ready', restartCount: 1 })
    await vi.waitFor(() =>
      expect(stub.request).toHaveBeenCalledWith({ type: 'startHotkeys' }, 5_000),
    )
  })

  it('preserves the overlay registration after a request timeout', async () => {
    const stub = supervisorStub()
    stub.request.mockRejectedValueOnce(
      new NativeRuntimeRequestError({
        code: 'request_timeout',
        message: 'request timed out',
        retryable: true,
      }),
    )
    const controller = new HooksRuntimeController(stub.supervisor)
    vi.spyOn(controller, 'isAvailable').mockReturnValue(true)
    const listener = vi.fn()

    await expect(controller.startOverlay(listener)).rejects.toThrow('request timed out')
    stub.request.mockClear()
    stub.state({ status: 'ready', restartCount: 1 })

    await vi.waitFor(() =>
      expect(stub.request).toHaveBeenCalledWith({ type: 'startOverlay' }, 5_000),
    )
  })

  it('allows retry after a definitive hook installation rejection', async () => {
    const stub = supervisorStub()
    stub.request.mockRejectedValueOnce(
      new NativeRuntimeRequestError({
        code: 'hook_install_failed',
        message: 'Windows rejected the hook',
        retryable: true,
      }),
    )
    const controller = new HooksRuntimeController(stub.supervisor)
    vi.spyOn(controller, 'isAvailable').mockReturnValue(true)
    const listener = vi.fn()

    await expect(controller.startHotkeys(listener)).rejects.toThrow(
      'Windows rejected the hook',
    )
    await expect(controller.startHotkeys(listener)).resolves.toBeUndefined()
    expect(stub.request).toHaveBeenCalledTimes(2)
  })

  it('clears the foreground target while recovering', async () => {
    const stub = supervisorStub()
    const controller = new HooksRuntimeController(stub.supervisor)
    vi.spyOn(controller, 'isAvailable').mockReturnValue(true)
    const listener = vi.fn()
    await controller.startOverlay(listener)

    stub.state({ status: 'recovering', restartCount: 1 })
    expect(listener).toHaveBeenLastCalledWith(null)
  })
})
