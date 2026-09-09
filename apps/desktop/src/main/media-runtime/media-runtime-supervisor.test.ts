import { describe, expect, it, vi } from 'vitest'
import { createInactiveMediaPaths } from './contract'

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

  async kill() {
    this.killed = true
  }

  ready() {
    this.callbacks?.onMessage({
      type: 'ready',
      protocolVersion: 4,
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
      protocolVersion: 4,
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
  it('fences diagnostic causes across 100 fatal host failures and replacements', async () => {
    vi.useFakeTimers()
    try {
      const causes = new Set<string>()
      for (let iteration = 0; iteration < 100; iteration += 1) {
        const first = new FakeMediaAdapter()
        const second = new FakeMediaAdapter()
        const adapters = [first, second]
        const supervisor = new MediaRuntimeSupervisor({
          createAdapter: () => adapters.shift()!, restartDelaysMs: [10],
        })
        let nativeEventCause: string | undefined
        supervisor.onEvent(() => { nativeEventCause = supervisor.getFailureEpisodeId() })
        const start = supervisor.start()
        first.ready()
        await start
        const fatal = {
          type: 'event', protocolVersion: 4,
          event: {
            type: 'fatalEngineFailure', sequence: 1,
            failure: { code: 'native_owner_stop_timeout', message: 'Owner did not join', stage: 'shutdown', retryable: true },
          },
        }
        first.callbacks!.onMessage(fatal)
        const cause = supervisor.getFailureEpisodeId()
        expect(cause).toBeDefined()
        expect(nativeEventCause).toBe(cause)
        expect(supervisor.getSnapshot().status).toBe('recovering')
        await vi.advanceTimersByTimeAsync(10)
        expect(supervisor.getFailureEpisodeId()).toBe(cause)
        second.ready()
        expect(supervisor.getFailureEpisodeId()).toBeUndefined()
        first.callbacks!.onMessage(fatal)
        expect(supervisor.getFailureEpisodeId()).toBeUndefined()
        second.unexpectedExit()
        const secondCause = supervisor.getFailureEpisodeId()
        expect(secondCause).toBeDefined()
        expect(secondCause).not.toBe(cause)
        causes.add(cause!)
        causes.add(secondCause!)
        expect(supervisor.getSnapshot().status).toBe('failed')
        await supervisor.shutdown()
      }
      expect(causes.size).toBe(200)
    } finally { vi.useRealTimers() }
  })

  it('keeps concurrent shutdown callers waiting for retirement after a protocol failure', async () => {
    vi.useFakeTimers()
    try {
      const adapter = new FakeMediaAdapter()
      let confirmExit = () => {}
      adapter.kill = () => new Promise<void>(resolve => { confirmExit = resolve })
      const supervisor = new MediaRuntimeSupervisor({ createAdapter: () => adapter })
      const started = supervisor.start()
      adapter.ready()
      await started
      const completed = vi.fn()
      const first = supervisor.shutdown().then(completed)
      const second = supervisor.shutdown().then(completed)
      adapter.callbacks?.onMessage({ invalid: true })
      await vi.advanceTimersByTimeAsync(1)
      expect(completed).not.toHaveBeenCalled()
      confirmExit()
      await Promise.all([first, second])
      expect(completed).toHaveBeenCalledTimes(2)
      expect(supervisor.getSnapshot().status).toBe('stopped')
    } finally { vi.useRealTimers() }
  })

  it('waits for confirmed utility termination before allowing a replacement', async () => {
    vi.useFakeTimers()
    try {
      const adapter = new FakeMediaAdapter()
      let confirmExit: () => void = () => undefined
      adapter.kill = () => new Promise<void>(resolve => { confirmExit = resolve })
      const replacement = new FakeMediaAdapter()
      const createAdapter = vi.fn().mockReturnValueOnce(adapter).mockReturnValue(replacement)
      const supervisor = new MediaRuntimeSupervisor({ createAdapter, restartDelaysMs: [10] })
      const started = supervisor.start()
      adapter.ready()
      await started
      adapter.callbacks?.onMessage({ invalid: true })
      const restart = expect(supervisor.start()).rejects.toMatchObject({
        failure: { code: 'media_host_recovering' },
      })
      await vi.advanceTimersByTimeAsync(100)
      expect(createAdapter).toHaveBeenCalledTimes(1)
      confirmExit()
      await vi.advanceTimersByTimeAsync(10)
      expect(createAdapter).toHaveBeenCalledTimes(2)
      replacement.ready()
      await restart
      replacement.unexpectedExit()
      await supervisor.shutdown()
    } finally { vi.useRealTimers() }
  })

  it('fails closed when the previous utility cannot be terminated', async () => {
    const adapter = new FakeMediaAdapter()
    adapter.kill = async () => { throw new Error('process still alive') }
    const createAdapter = vi.fn(() => adapter)
    const supervisor = new MediaRuntimeSupervisor({ createAdapter })
    const started = supervisor.start()
    adapter.ready()
    await started
    adapter.callbacks?.onMessage({ invalid: true })
    await expect(supervisor.start()).rejects.toMatchObject({
      failure: { code: 'media_host_termination_failed' },
    })
    await expect(supervisor.retry()).rejects.toMatchObject({
      failure: { code: 'media_host_termination_failed' },
    })
    expect(createAdapter).toHaveBeenCalledTimes(1)
    expect(supervisor.getSnapshot().status).toBe('failed')
    await expect(supervisor.shutdown()).rejects.toMatchObject({
      failure: { code: 'media_host_termination_failed' },
    })
    expect(supervisor.getSnapshot().status).toBe('failed')
  })

  it('records utility exit evidence without forwarding stderr contents', async () => {
    const adapter = new FakeMediaAdapter()
    const record = vi.fn()
    const supervisor = new MediaRuntimeSupervisor({
      createAdapter: () => adapter, restartDelaysMs: [], onUtilityExit: record,
    })
    const started = supervisor.start()
    adapter.ready()
    await started
    adapter.callbacks?.onExit({
      code: 0xc0000409, source: 'exit', expected: false, uptimeMs: 1200,
      stderr: 'private-device-name', stderrTruncated: true,
    })
    expect(record).toHaveBeenCalledWith({
      code: 0xc0000409, source: 'exit', expected: false, uptimeMs: 1200,
      stderrBytes: 19, stderrTruncated: true,
    })
    expect(supervisor.getSnapshot().status).toBe('failed')
    await supervisor.shutdown()
  })

  it('exhausts its retry budget when every recovered host crashes after ready', async () => {
    vi.useFakeTimers()
    try {
      const adapters: FakeMediaAdapter[] = []
      const supervisor = new MediaRuntimeSupervisor({
        createAdapter: () => {
          const adapter = new FakeMediaAdapter()
          adapters.push(adapter)
          return adapter
        },
        restartDelaysMs: [10, 20],
      })
      const started = supervisor.start()
      adapters[0]!.ready()
      await started
      for (const delay of [10, 20]) {
        adapters.at(-1)!.unexpectedExit()
        await vi.advanceTimersByTimeAsync(delay)
        adapters.at(-1)!.ready()
      }
      adapters.at(-1)!.unexpectedExit()
      await vi.advanceTimersByTimeAsync(60_000)
      expect(adapters).toHaveLength(3)
      expect(supervisor.getSnapshot().status).toBe('failed')
      const automaticStart = supervisor.start().catch(error => error)
      expect(adapters).toHaveLength(3)
      expect(await automaticStart).toMatchObject({ failure: { code: 'unexpected_exit' } })
      const manualStart = supervisor.retry()
      expect(adapters).toHaveLength(4)
      adapters.at(-1)!.ready()
      await manualStart
      // Only explicit Retry replenishes the two-attempt automatic budget.
      for (const delay of [10, 20]) {
        adapters.at(-1)!.unexpectedExit()
        await vi.advanceTimersByTimeAsync(delay)
        adapters.at(-1)!.ready()
      }
      adapters.at(-1)!.unexpectedExit()
      await vi.advanceTimersByTimeAsync(60_000)
      expect(adapters).toHaveLength(6)
      expect(supervisor.getSnapshot().status).toBe('failed')
      await supervisor.shutdown()
    } finally {
      vi.useRealTimers()
    }
  })

  it('does not let an ordinary start bypass the scheduled recovery backoff', async () => {
    vi.useFakeTimers()
    try {
      const first = new FakeMediaAdapter()
      const second = new FakeMediaAdapter()
      const createAdapter = vi.fn().mockReturnValueOnce(first).mockReturnValue(second)
      const supervisor = new MediaRuntimeSupervisor({ createAdapter, restartDelaysMs: [100] })
      const started = supervisor.start()
      first.ready()
      await started
      first.unexpectedExit()
      const automaticStart = supervisor.start().catch(error => error)
      expect(createAdapter).toHaveBeenCalledTimes(1)
      expect(await automaticStart).toMatchObject({ failure: { code: 'media_host_recovering' } })
      await vi.advanceTimersByTimeAsync(99)
      expect(createAdapter).toHaveBeenCalledTimes(1)
      await vi.advanceTimersByTimeAsync(1)
      expect(createAdapter).toHaveBeenCalledTimes(2)
      second.ready()
      second.unexpectedExit()
      await supervisor.shutdown()
    } finally { vi.useRealTimers() }
  })

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
      protocolVersion: 4,
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
      protocolVersion: 4,
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
        tracks: createInactiveMediaPaths(1),
      },
    })

    await vi.waitFor(() => expect(onSnapshot).toHaveBeenCalledOnce())
    expect(supervisor.getLatestEngineSnapshot()).toMatchObject({
      roomState: 'connected',
    })
  })

  it('retires and replaces a utility epoch after a fatal native engine failure', async () => {
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
    const pendingPing = supervisor.ping()
    await vi.waitFor(() => expect(first.requests).toHaveLength(1))
    const cause = supervisor.getFailureEpisodeId(1)
    const projectedCauses: (string | undefined)[] = []
    supervisor.onEvent(event => projectedCauses.push(supervisor.getFailureEpisodeId(event.failure?.causeSequence)))
    const nativeFailure = {
      code: 'room_operation_unresponsive',
      message: 'Room operation exceeded its independent deadline',
      stage: 'room_disconnect', retryable: true, causeSequence: 1,
    }
    first.callbacks?.onMessage({
      type: 'event', protocolVersion: 4,
      event: { type: 'roomStateChanged', sequence: 1, revision: 1, state: 'failed', failure: nativeFailure },
    })
    first.callbacks?.onMessage({
      type: 'event', protocolVersion: 4,
      event: { type: 'engineStateChanged', sequence: 2, previous: 'running', state: 'failed', failure: nativeFailure },
    })
    expect(first.killed).toBe(false)

    first.callbacks?.onMessage({
      type: 'event',
      protocolVersion: 4,
      event: {
        type: 'fatalEngineFailure',
        sequence: 3,
        failure: nativeFailure,
      },
    })

    expect(first.killed).toBe(true)
    expect(projectedCauses).toEqual([cause, cause, cause])
    expect(supervisor.getFailureEpisodeId()).toBe(cause)
    expect(supervisor.getSnapshot()).toMatchObject({
      status: 'recovering',
      failure: { code: 'room_operation_unresponsive' },
    })
    await expect(pendingPing).rejects.toMatchObject({
      failure: { code: 'room_operation_unresponsive' },
    })
    await vi.advanceTimersByTimeAsync(10)
    second.ready()
    await vi.waitFor(() => expect(supervisor.getSnapshot().status).toBe('ready'))
    expect(supervisor.getSnapshot().restartCount).toBe(1)
    expect(supervisor.getFailureEpisodeId(1)).not.toBe(cause)
    expect(second.requests).toHaveLength(0)

    const shutdown = supervisor.shutdown()
    await vi.advanceTimersByTimeAsync(0)
    second.reply(requestId(second.requests[0]), {
      type: 'shutdownComplete',
      engineState: 'stopped',
    })
    await shutdown
    vi.useRealTimers()
  })
})
