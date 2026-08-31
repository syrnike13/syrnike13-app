import { describe, expect, it, vi } from 'vitest'

import type {
  MediaUtilityAdapter,
  MediaUtilityCallbacks,
} from './media-utility-adapter'
import { MediaRuntimeSupervisor } from './media-runtime-supervisor'
import { MEDIA_LIFECYCLE_SCHEMA_SHA256 } from './contract'

const COMMIT_SHA = 'c'.repeat(40)

class FakeMediaAdapter implements MediaUtilityAdapter {
  readonly pid = 81
  callbacks: MediaUtilityCallbacks | null = null
  readonly requests: unknown[] = []
  killed = false

  start(callbacks: MediaUtilityCallbacks) {
    this.callbacks = callbacks
  }

  postMessage(message: unknown) {
    this.requests.push(message)
  }

  kill() {
    this.killed = true
  }

  ready() {
    this.callbacks?.onMessage({
      type: 'ready',
      protocolVersion: 3,
      engineState: 'running',
      build: {
        commit: COMMIT_SHA,
        napi: '8',
        protocolSchemaSha256: MEDIA_LIFECYCLE_SCHEMA_SHA256,
      },
    })
  }

  reply(requestId: string, result?: unknown) {
    this.callbacks?.onMessage({
      type: 'reply',
      protocolVersion: 3,
      requestId,
      ok: true,
      result,
    })
  }

  unexpectedExit() {
    this.callbacks?.onExit({
      code: 9,
      source: 'exit',
      expected: false,
      uptimeMs: 20,
      stderr: '',
      stderrTruncated: false,
    })
  }
}

function requestId(value: unknown) {
  if (typeof value !== 'object' || value === null) throw new Error('request missing')
  const id = Reflect.get(value, 'requestId')
  if (typeof id !== 'string') throw new Error('request id missing')
  return id
}

describe('MediaRuntimeSupervisor', () => {
  it('routes handshake, ping, and bounded graceful shutdown', async () => {
    const adapter = new FakeMediaAdapter()
    const supervisor = new MediaRuntimeSupervisor({
      createAdapter: () => adapter,
    })
    const started = supervisor.start()
    adapter.ready()
    await started

    const handshake = supervisor.handshake()
    await vi.waitFor(() => expect(adapter.requests).toHaveLength(1))
    adapter.reply(requestId(adapter.requests[0]), {
      type: 'handshake',
      protocolVersion: 3,
      engineState: 'running',
      build: {
        commit: COMMIT_SHA,
        napi: '8',
        protocolSchemaSha256: MEDIA_LIFECYCLE_SCHEMA_SHA256,
      },
    })
    await expect(handshake).resolves.toMatchObject({ type: 'handshake' })

    const ping = supervisor.ping()
    await vi.waitFor(() => expect(adapter.requests).toHaveLength(2))
    adapter.reply(requestId(adapter.requests[1]), {
      type: 'pong',
      engineState: 'running',
    })
    await expect(ping).resolves.toEqual({
      type: 'pong',
      engineState: 'running',
    })

    const shutdown = supervisor.shutdown()
    await vi.waitFor(() => expect(adapter.requests).toHaveLength(3))
    adapter.reply(requestId(adapter.requests[2]), {
      type: 'shutdownComplete',
      engineState: 'stopped',
    })
    await shutdown
    expect(adapter.killed).toBe(true)
    expect(supervisor.getSnapshot().status).toBe('stopped')
    expect(supervisor.getPendingRequestCount()).toBe(0)
  })

  it('detects unexpected exit and performs only the bounded restart policy', async () => {
    vi.useFakeTimers()
    const first = new FakeMediaAdapter()
    const second = new FakeMediaAdapter()
    const adapters = [first, second]
    const supervisor = new MediaRuntimeSupervisor({
      createAdapter: () => {
        const adapter = adapters.shift()
        if (!adapter) throw new Error('restart budget exhausted')
        return adapter
      },
      restartDelaysMs: [10],
    })
    const started = supervisor.start()
    first.ready()
    await started
    first.unexpectedExit()
    expect(supervisor.getSnapshot()).toMatchObject({
      status: 'recovering',
      failure: { code: 'unexpected_exit' },
    })
    await vi.advanceTimersByTimeAsync(10)
    second.ready()
    await vi.waitFor(() => expect(supervisor.getSnapshot().status).toBe('ready'))
    expect(supervisor.getSnapshot().restartCount).toBe(1)
    const shutdown = supervisor.shutdown()
    await vi.advanceTimersByTimeAsync(0)
    expect(second.requests).toHaveLength(1)
    second.reply(requestId(second.requests[0]), {
      type: 'shutdownComplete',
      engineState: 'stopped',
    })
    await shutdown
    vi.useRealTimers()
  })

  it('rejects an incompatible handshake and stops after zero configured retries', async () => {
    const adapter = new FakeMediaAdapter()
    const supervisor = new MediaRuntimeSupervisor({
      createAdapter: () => adapter,
      restartDelaysMs: [],
    })
    const started = supervisor.start()
    adapter.callbacks?.onMessage({
      type: 'ready',
      protocolVersion: 0,
      engineState: 'failed',
      failure: {
        code: 'protocol_incompatible',
        message: 'incompatible',
        stage: 'handshake',
        retryable: false,
      },
    })
    await expect(started).rejects.toMatchObject({
      failure: { code: 'protocol_incompatible' },
    })
    expect(adapter.killed).toBe(true)
    expect(supervisor.getSnapshot().status).toBe('failed')
  })

  it('settles a pending start when shutdown happens before the handshake', async () => {
    const adapter = new FakeMediaAdapter()
    const supervisor = new MediaRuntimeSupervisor({
      createAdapter: () => adapter,
    })
    const started = supervisor.start()
    const startFailure = expect(started).rejects.toMatchObject({
      failure: { code: 'media_host_stopped' },
    })

    await supervisor.shutdown()

    await startFailure
    expect(adapter.killed).toBe(true)
    expect(supervisor.getSnapshot().status).toBe('stopped')
  })

  it('settles start when the adapter factory throws synchronously', async () => {
    const supervisor = new MediaRuntimeSupervisor({
      createAdapter: () => {
        throw new Error('factory failed')
      },
      restartDelaysMs: [],
    })

    await expect(supervisor.start()).rejects.toMatchObject({
      failure: { code: 'media_host_start_failed' },
    })
    expect(supervisor.getSnapshot()).toMatchObject({
      status: 'failed',
      failure: { code: 'media_host_start_failed' },
    })
  })

  it('validates command-specific reply payloads', async () => {
    const adapter = new FakeMediaAdapter()
    const supervisor = new MediaRuntimeSupervisor({
      createAdapter: () => adapter,
    })
    const started = supervisor.start()
    adapter.ready()
    await started

    const query = supervisor.querySnapshot()
    await vi.waitFor(() => expect(adapter.requests).toHaveLength(1))
    adapter.reply(requestId(adapter.requests[0]), {
      type: 'pong',
      engineState: 'running',
    })
    await expect(query).rejects.toMatchObject({
      failure: { code: 'media_snapshot_invalid' },
    })
  })

  it('recovers a coherent snapshot when the first public event has a sequence gap', async () => {
    const adapter = new FakeMediaAdapter()
    const supervisor = new MediaRuntimeSupervisor({
      createAdapter: () => adapter,
    })
    const onSnapshot = vi.fn()
    supervisor.onSnapshot(onSnapshot)
    const started = supervisor.start()
    adapter.ready()
    await started

    adapter.callbacks?.onMessage({
      type: 'event',
      protocolVersion: 3,
      event: {
        type: 'roomStateChanged',
        sequence: 3,
        revision: 1,
        state: 'connected',
      },
    })

    await vi.waitFor(() => expect(adapter.requests).toHaveLength(1))
    expect(adapter.requests[0]).toMatchObject({
      command: { type: 'querySnapshot' },
    })
    adapter.reply(requestId(adapter.requests[0]), {
      type: 'snapshot',
      snapshot: {
        engineState: 'running',
        acceptedRevision: 1,
        desiredState: null,
        roomState: 'connected',
        tracks: {
          microphone: 'off',
          camera: 'off',
          screen: 'off',
          output: 'off',
        },
      },
    })

    await vi.waitFor(() => expect(onSnapshot).toHaveBeenCalledOnce())
    expect(supervisor.getLatestEngineSnapshot()).toMatchObject({
      roomState: 'connected',
    })
  })
})
