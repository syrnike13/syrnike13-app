import { EventEmitter } from 'node:events'

import { describe, expect, it, vi } from 'vitest'

import { NATIVE_RUNTIME_CONTRACT_VERSION } from './contract'
import { NativeRuntimeSupervisor } from './runtime-supervisor'
import type {
  NativeRuntimeAdapter,
  NativeRuntimeAdapterCallbacks,
} from './utility-adapter'

class FakeAdapter extends EventEmitter implements NativeRuntimeAdapter {
  readonly pid = 42
  callbacks: NativeRuntimeAdapterCallbacks | null = null
  readonly requests: unknown[] = []
  killed = false

  start(callbacks: NativeRuntimeAdapterCallbacks) {
    this.callbacks = callbacks
  }

  postMessage(message: unknown) {
    this.requests.push(message)
  }

  kill() {
    this.killed = true
  }

  ready(runtime: 'hotkey' | 'overlay' = 'hotkey') {
    this.callbacks?.onMessage({
      type: 'ready',
      contractVersion: NATIVE_RUNTIME_CONTRACT_VERSION,
      runtime,
      capabilities: [runtime === 'hotkey' ? 'hotkeys' : 'overlay'],
      build: { napi: '8' },
    })
  }

  reply(requestId: string) {
    this.callbacks?.onMessage({ type: 'reply', requestId, ok: true })
  }
}

describe('NativeRuntimeSupervisor hook boundary', () => {
  it('starts a hook host and routes a typed request/reply', async () => {
    const adapter = new FakeAdapter()
    const supervisor = new NativeRuntimeSupervisor({
      runtime: 'hotkey',
      createAdapter: () => adapter,
    })

    const started = supervisor.start()
    adapter.ready()
    await started
    const request = supervisor.request({ type: 'startHotkeys' })
    await vi.waitFor(() => expect(adapter.requests).toHaveLength(1))
    const sent = adapter.requests[0]
    expect(sent).toMatchObject({
      type: 'request',
      lane: 'hotkey',
      command: { type: 'startHotkeys' },
    })
    if (typeof sent !== 'object' || sent === null) throw new Error('request missing')
    const requestId = Reflect.get(sent, 'requestId')
    if (typeof requestId !== 'string') throw new Error('request id missing')
    adapter.reply(requestId)
    await expect(request).resolves.toBeUndefined()
  })

  it('rejects a command owned by the other hook runtime', async () => {
    const adapter = new FakeAdapter()
    const supervisor = new NativeRuntimeSupervisor({
      runtime: 'hotkey',
      createAdapter: () => adapter,
    })
    const started = supervisor.start()
    adapter.ready()
    await started

    await expect(supervisor.request({ type: 'startOverlay' })).rejects.toMatchObject({
      detail: { code: 'invalid_runtime_command', retryable: false },
    })
  })

  it('recovers a hook host and increments restartCount', async () => {
    vi.useFakeTimers()
    const first = new FakeAdapter()
    const second = new FakeAdapter()
    const adapters = [first, second]
    const supervisor = new NativeRuntimeSupervisor({
      runtime: 'hotkey',
      createAdapter: () => {
        const adapter = adapters.shift()
        if (!adapter) throw new Error('missing adapter')
        return adapter
      },
      restartDelaysMs: [10],
    })
    const started = supervisor.start()
    first.ready()
    await started

    first.callbacks?.onExit({ code: 1 })
    expect(supervisor.getSnapshot().status).toBe('recovering')
    await vi.advanceTimersByTimeAsync(10)
    second.ready()
    await vi.waitFor(() => expect(supervisor.getSnapshot().status).toBe('ready'))
    expect(supervisor.getSnapshot().restartCount).toBe(1)
    vi.useRealTimers()
  })
})
