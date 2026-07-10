import { describe, expect, it, vi } from 'vitest'

import {
  NATIVE_RUNTIME_CONTRACT_VERSION,
  type NativeRuntimeReady,
  type NativeRuntimeRequest,
} from './contract'
import {
  NativeRuntimeRequestError,
  NativeRuntimeSupervisor,
} from './runtime-supervisor'
import type {
  NativeRuntimeAdapter,
  NativeRuntimeAdapterCallbacks,
} from './utility-adapter'

const READY: NativeRuntimeReady = {
  type: 'ready',
  contractVersion: NATIVE_RUNTIME_CONTRACT_VERSION,
  runtime: 'hooks',
  capabilities: ['hotkeys', 'overlay'],
  build: {},
}

class FakeAdapter implements NativeRuntimeAdapter {
  readonly pid = 42
  callbacks: NativeRuntimeAdapterCallbacks | null = null
  requests: NativeRuntimeRequest[] = []
  startError: Error | null = null
  postError: Error | null = null
  killed = false

  start(callbacks: NativeRuntimeAdapterCallbacks) {
    this.callbacks = callbacks
    if (this.startError) throw this.startError
  }

  postMessage(message: NativeRuntimeRequest) {
    if (this.postError) throw this.postError
    this.requests.push(message)
  }

  kill() {
    this.killed = true
  }

  ready() {
    this.callbacks?.onMessage(READY)
  }

  reply(index: number, result: unknown) {
    this.callbacks?.onMessage({
      type: 'reply',
      requestId: this.requests[index].requestId,
      ok: true,
      result,
    })
  }

  exit(code = 1) {
    this.callbacks?.onExit({ code })
  }
}

describe('NativeRuntimeSupervisor', () => {
  it('handshakes and correlates typed replies', async () => {
    const adapter = new FakeAdapter()
    const supervisor = new NativeRuntimeSupervisor({
      runtime: 'hooks',
      createAdapter: () => adapter,
    })

    const start = supervisor.start()
    adapter.ready()
    await expect(start).resolves.toEqual(READY)

    const request = supervisor.request({ type: 'startHotkeys' }, 1_000)
    await vi.waitFor(() => expect(adapter.requests).toHaveLength(1))
    adapter.reply(0, { started: true })
    await expect(request).resolves.toEqual({ started: true })
    expect(supervisor.getSnapshot()).toMatchObject({
      status: 'ready',
      pid: 42,
    })
  })

  it('rejects a synchronous initial start failure and schedules recovery once', async () => {
    const adapter = new FakeAdapter()
    adapter.startError = new Error('load failed')
    const scheduled: Array<() => void> = []
    const supervisor = new NativeRuntimeSupervisor({
      runtime: 'hooks',
      createAdapter: () => adapter,
      schedule: (callback) => {
        scheduled.push(callback)
        return 1 as unknown as ReturnType<typeof setTimeout>
      },
    })

    await expect(supervisor.start()).rejects.toMatchObject({
      detail: { code: 'handshake_failed' },
    })
    expect(supervisor.getSnapshot().status).toBe('recovering')
    expect(scheduled).toHaveLength(1)
  })

  it('rejects pending work as runtime_lost and enters the circuit after crashes', async () => {
    const adapters: FakeAdapter[] = []
    const scheduled: Array<() => void> = []
    const supervisor = new NativeRuntimeSupervisor({
      runtime: 'hooks',
      createAdapter: () => {
        const adapter = new FakeAdapter()
        adapters.push(adapter)
        return adapter
      },
      now: () => 100,
      schedule: (callback) => {
        scheduled.push(callback)
        return 1 as unknown as ReturnType<typeof setTimeout>
      },
    })

    const firstStart = supervisor.start()
    const first = adapters[0]
    first.ready()
    await firstStart
    const pending = supervisor.request({ type: 'startHotkeys' }, 1_000)
    await vi.waitFor(() => expect(first.requests).toHaveLength(1))
    first.exit()
    await expect(pending).rejects.toMatchObject({
      detail: { code: 'runtime_lost' },
    })

    scheduled.shift()?.()
    await vi.waitFor(() => expect(adapters).toHaveLength(2))
    const second = adapters[1]
    second.ready()
    await vi.waitFor(() => expect(supervisor.getSnapshot().status).toBe('ready'))
    second.exit()
    scheduled.shift()?.()
    await vi.waitFor(() => expect(adapters).toHaveLength(3))
    const third = adapters[2]
    third.ready()
    await vi.waitFor(() => expect(supervisor.getSnapshot().status).toBe('ready'))
    third.exit()

    expect(supervisor.getSnapshot()).toMatchObject({
      status: 'degraded',
      restartCount: 2,
    })
  })

  it('rejects a mismatched contract without a restart loop', async () => {
    const adapter = new FakeAdapter()
    const supervisor = new NativeRuntimeSupervisor({
      runtime: 'hooks',
      createAdapter: () => adapter,
    })
    const start = supervisor.start()
    adapter.callbacks?.onMessage({ ...READY, contractVersion: 999 })
    await expect(start).rejects.toBeInstanceOf(NativeRuntimeRequestError)
    expect(supervisor.getSnapshot().status).toBe('degraded')
  })

  it('rejects an addon with missing runtime identity without starting workers', async () => {
    const adapters: FakeAdapter[] = []
    const supervisor = new NativeRuntimeSupervisor({
      runtime: 'hooks',
      createAdapter: () => {
        const adapter = new FakeAdapter()
        adapters.push(adapter)
        return adapter
      },
    })
    const start = supervisor.start()
    const adapter = adapters[0]
    adapter.callbacks?.onMessage({ ...READY, runtime: 'invalid' })

    await expect(start).rejects.toMatchObject({
      message: expect.stringContaining('kind mismatch'),
    })
    expect(adapter.killed).toBe(true)
    expect(supervisor.getSnapshot()).toMatchObject({
      status: 'degraded',
      restartCount: 0,
    })

    const retry = supervisor.retry()
    const retriedAdapter = adapters[1]
    retriedAdapter.ready()
    await expect(retry).resolves.toEqual(READY)
    expect(supervisor.getSnapshot()).toMatchObject({
      status: 'ready',
      restartCount: 1,
    })
  })

  it('recycles a host when a native request hangs', async () => {
    const adapter = new FakeAdapter()
    const scheduled: Array<() => void> = []
    const supervisor = new NativeRuntimeSupervisor({
      runtime: 'hooks',
      createAdapter: () => adapter,
      schedule: (callback) => {
        scheduled.push(callback)
        return 1 as unknown as ReturnType<typeof setTimeout>
      },
    })
    const start = supervisor.start()
    adapter.ready()
    await start

    await expect(
      supervisor.request({ type: 'startHotkeys' }, 5),
    ).rejects.toMatchObject({ detail: { code: 'request_timeout' } })
    expect(adapter.killed).toBe(true)
    expect(supervisor.getSnapshot().status).toBe('recovering')
    expect(scheduled).toHaveLength(1)
  })

  it('recycles a host when structured-clone delivery fails before exit', async () => {
    const adapter = new FakeAdapter()
    const scheduled: Array<() => void> = []
    const supervisor = new NativeRuntimeSupervisor({
      runtime: 'hooks',
      createAdapter: () => adapter,
      schedule: (callback) => {
        scheduled.push(callback)
        return 1 as unknown as ReturnType<typeof setTimeout>
      },
    })
    const start = supervisor.start()
    adapter.ready()
    await start
    adapter.postError = new Error('message port closed')

    await expect(
      supervisor.request({ type: 'startHotkeys' }, 1_000),
    ).rejects.toMatchObject({ detail: { code: 'runtime_lost' } })
    expect(adapter.killed).toBe(true)
    expect(supervisor.getSnapshot().status).toBe('recovering')
    expect(scheduled).toHaveLength(1)
  })

  it('rejects an in-progress handshake during shutdown', async () => {
    const adapter = new FakeAdapter()
    const supervisor = new NativeRuntimeSupervisor({
      runtime: 'hooks',
      createAdapter: () => adapter,
    })
    const start = supervisor.start()

    await supervisor.shutdown()

    await expect(start).rejects.toMatchObject({
      detail: { code: 'runtime_stopped' },
    })
    expect(adapter.killed).toBe(true)
    expect(supervisor.getSnapshot().status).toBe('stopped')
  })

  it('allows a ready utility host to exit after graceful native shutdown', async () => {
    const adapter = new FakeAdapter()
    const supervisor = new NativeRuntimeSupervisor({
      runtime: 'hooks',
      createAdapter: () => adapter,
    })
    const start = supervisor.start()
    adapter.ready()
    await start

    const shutdown = supervisor.shutdown()
    await vi.waitFor(() => expect(adapter.requests).toHaveLength(1))
    expect(adapter.requests[0]?.command).toEqual({ type: 'shutdown' })
    adapter.reply(0, undefined)
    await Promise.resolve()
    expect(adapter.killed).toBe(false)
    adapter.exit(0)

    await shutdown
    expect(adapter.killed).toBe(false)
    expect(supervisor.getSnapshot().status).toBe('stopped')
  })
})
