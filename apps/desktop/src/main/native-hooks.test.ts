import { Effect } from 'effect'
import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  app: { isPackaged: false, getAppPath: () => process.cwd() },
}))

import { HooksRuntimeController, type NativeHooksEvent } from './native-hooks'

function fakeAddon(reply: (type: string) => boolean = () => true) {
  let emit: (event: NativeHooksEvent) => void = () => {}
  const commands: string[] = []
  const addon = {
    createHooksRuntime(callback: (event: NativeHooksEvent) => void) {
      emit = callback
      return {
        dispatch({ type, requestId }: { type: string; requestId: string }) {
          commands.push(type)
          queueMicrotask(() => {
            const ok = reply(type)
            emit({ type: 'reply', requestId, ok, ...(ok ? {} : { error: { code: 'x', message: 'failed', retryable: false } }) })
          })
        },
        shutdown: vi.fn(async () => {}),
      }
    },
  }
  return { addon, commands, emit: (event: NativeHooksEvent) => emit(event) }
}

describe('native hooks controller', () => {
  it('starts hotkeys once, delivers input and stops after the last listener', async () => {
    const fake = fakeAddon()
    const controller = new HooksRuntimeController(() => fake.addon, 'win32')
    const first = vi.fn()
    const second = vi.fn()
    await Effect.runPromise(controller.startHotkeysEffect(first))
    await Effect.runPromise(controller.startHotkeysEffect(second))
    expect(fake.commands).toEqual(['startHotkeys'])
    expect(controller.isRunning('hotkey')).toBe(true)

    const input = { type: 'keyDown', code: 'KeyA' } as never
    fake.emit({ type: 'input', sequence: 1, input })
    expect(first).toHaveBeenCalledWith(input)
    expect(second).toHaveBeenCalledWith(input)

    await controller.stopHotkeys(first)
    expect(fake.commands).toEqual(['startHotkeys'])
    await controller.stopHotkeys(second)
    expect(fake.commands).toEqual(['startHotkeys', 'stopHotkeys'])
    expect(controller.isRunning('hotkey')).toBe(false)
  })

  it('forgets a listener whose start failed so the next start retries', async () => {
    let fail = true
    const fake = fakeAddon(() => !fail)
    const controller = new HooksRuntimeController(() => fake.addon, 'win32')
    await expect(Effect.runPromise(controller.startOverlayEffect(vi.fn()))).rejects.toThrow('failed')
    fail = false
    const listener = vi.fn()
    await Effect.runPromise(controller.startOverlayEffect(listener))
    expect(fake.commands).toEqual(['startOverlay', 'startOverlay'])
    fake.emit({ type: 'foregroundWindow', sequence: 1, window: null })
    expect(listener).toHaveBeenCalledWith(null)
  })

  it('reports runtime errors and is unavailable off Windows or without the addon', async () => {
    const fake = fakeAddon()
    const controller = new HooksRuntimeController(() => fake.addon, 'win32')
    const onError = vi.fn()
    controller.onRuntimeError(onError)
    expect(controller.isAvailable()).toBe(true)
    fake.emit({ type: 'runtimeError', sequence: 1, error: { code: 'hook_lost', message: 'lost', retryable: true } })
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ code: 'hook_lost' }))

    expect(new HooksRuntimeController(() => fake.addon, 'linux').isAvailable()).toBe(false)
    const missing = new HooksRuntimeController(() => { throw new Error('not found') }, 'win32')
    await expect(Effect.runPromise(missing.startHotkeysEffect(vi.fn()))).rejects.toThrow('not available')
  })
})
