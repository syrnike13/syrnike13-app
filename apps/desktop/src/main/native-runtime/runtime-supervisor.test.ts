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
  runtime: 'hotkey',
  capabilities: ['hotkeys'],
  build: {},
}

const MEDIA_READY: NativeRuntimeReady = {
  type: 'ready',
  contractVersion: NATIVE_RUNTIME_CONTRACT_VERSION,
  runtime: 'media',
  capabilities: ['microphone'],
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

  ready(ready: NativeRuntimeReady = READY) {
    this.callbacks?.onMessage(ready)
  }

  reply(index: number, result: unknown) {
    this.callbacks?.onMessage({
      type: 'reply',
      requestId: this.requests[index].requestId,
      ok: true,
      result,
    })
  }

  replyError(index: number, code: string) {
    const request = this.requests[index]
    this.callbacks?.onMessage({
      type: 'reply',
      requestId: request.requestId,
      ok: false,
      error: {
        code,
        message: `native error: ${code}`,
        retryable: true,
        stage: request.command.type,
      },
    })
  }

  replyByType(type: string, result: unknown = undefined) {
    const index = this.requests.findIndex((request) => request.command.type === type)
    if (index < 0) {
      throw new Error(`Missing request for ${type}`)
    }
    this.reply(index, result)
  }

  exit(code = 1) {
    this.callbacks?.onExit({ code })
  }
}

describe('NativeRuntimeSupervisor', () => {
  it('handshakes and correlates typed replies', async () => {
    const adapter = new FakeAdapter()
    const supervisor = new NativeRuntimeSupervisor({
      runtime: 'hotkey',
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

  it('carries action, operation, revision, generation, host, and request correlation', async () => {
    const adapter = new FakeAdapter()
    const diagnostics: Array<Record<string, unknown>> = []
    const supervisor = new NativeRuntimeSupervisor({
      runtime: 'media',
      createAdapter: () => adapter,
      diagnostics: (record) => diagnostics.push(record),
    })

    const start = supervisor.start()
    adapter.ready(MEDIA_READY)
    await start
    const request = supervisor.request(
      {
        type: 'connectMicrophone',
        sessionId: 'session-a',
        generation: 7,
        excludeProcessId: 42,
        options: {
          kind: 'microphone',
          requestId: 'media-a',
          participantIdentity: 'private-participant',
          muted: false,
        },
      },
      1_000,
      {
        diagnostic: {
          actionId: 'media-action-a',
          operationId: 'operation-a',
          revision: 11,
        },
      },
    )
    await vi.waitFor(() => expect(adapter.requests).toHaveLength(1))

    expect(adapter.requests[0]).toMatchObject({
      diagnostic: {
        actionId: 'media-action-a',
        operationId: 'operation-a',
        revision: 11,
        hostEpoch: 1,
      },
    })
    adapter.reply(0, { started: true })
    await request

    const failedRequest = supervisor.request(
      {
        type: 'connectMicrophone',
        sessionId: 'session-a',
        generation: 7,
        excludeProcessId: 42,
        options: {
          kind: 'microphone',
          requestId: 'media-a',
          participantIdentity: 'private-participant',
          muted: false,
        },
      },
      1_000,
      {
        diagnostic: {
          actionId: 'media-action-a',
          operationId: 'operation-a',
          revision: 11,
        },
      },
    )
    await vi.waitFor(() => expect(adapter.requests).toHaveLength(2))
    adapter.replyError(1, 'encoder_unavailable')
    await expect(failedRequest).rejects.toMatchObject({
      detail: { code: 'encoder_unavailable' },
    })

    expect(
      diagnostics.filter((record) => record.event === 'command_summary'),
    ).toEqual([
      expect.objectContaining({
        actionId: 'media-action-a',
        operation: 'operation-a',
        revision: 11,
        generation: 7,
        hostEpoch: 1,
        requestId: adapter.requests[0].requestId,
        stage: 'connectMicrophone',
        commandStage: 'completed',
        outcome: 'success',
      }),
      expect.objectContaining({
        actionId: 'media-action-a',
        operation: 'operation-a',
        revision: 11,
        generation: 7,
        hostEpoch: 1,
        requestId: adapter.requests[1].requestId,
        stage: 'connectMicrophone',
        commandStage: 'completed',
        outcome: 'error',
        errorCode: 'encoder_unavailable',
      }),
    ])
  })

  it('omits successful per-frame release diagnostics but preserves failures', async () => {
    const adapter = new FakeAdapter()
    const diagnostics: Array<Record<string, unknown>> = []
    const supervisor = new NativeRuntimeSupervisor({
      runtime: 'media',
      createAdapter: () => adapter,
      diagnostics: (record) => diagnostics.push(record),
    })

    const start = supervisor.start()
    adapter.ready(MEDIA_READY)
    await start
    const command = {
      type: 'releaseRemoteVideoFrame' as const,
      sessionId: 'voice',
      generation: 1,
      trackId: 'camera',
      sequence: 1,
    }
    const released = supervisor.request(command, 1_000)
    await vi.waitFor(() => expect(adapter.requests).toHaveLength(1))
    adapter.reply(0, undefined)
    await released

    expect(
      diagnostics.filter((record) => record.stage === command.type),
    ).toEqual([])

    const failed = supervisor.request({ ...command, sequence: 2 }, 1_000)
    await vi.waitFor(() => expect(adapter.requests).toHaveLength(2))
    adapter.replyError(1, 'release_failed')
    await expect(failed).rejects.toBeInstanceOf(NativeRuntimeRequestError)

    expect(
      diagnostics.filter((record) => record.stage === command.type),
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          event: 'request_reply_error',
          outcome: 'error',
          errorCode: 'release_failed',
        }),
        expect.objectContaining({
          event: 'command_summary',
          outcome: 'error',
          errorCode: 'release_failed',
        }),
      ]),
    )
  })

  it('waits for scheduled backoff and resets its delay after the crash window', async () => {
    const adapters: FakeAdapter[] = []
    const scheduled: Array<{ callback(): void; delayMs: number }> = []
    let now = 0
    const supervisor = new NativeRuntimeSupervisor({
      runtime: 'hotkey',
      createAdapter: () => {
        const adapter = new FakeAdapter()
        adapters.push(adapter)
        return adapter
      },
      now: () => now,
      schedule: (callback, delayMs) => {
        scheduled.push({ callback, delayMs })
        return scheduled.length as unknown as ReturnType<typeof setTimeout>
      },
    })

    const initialStart = supervisor.start()
    adapters[0].ready()
    await initialStart
    adapters[0].exit()
    expect(scheduled[0].delayMs).toBe(250)

    const waitingForBackoff = supervisor.start()
    expect(adapters).toHaveLength(1)
    scheduled[0].callback()
    expect(adapters).toHaveLength(2)
    adapters[1].ready()
    await waitingForBackoff

    now = 100
    adapters[1].exit()
    expect(scheduled[1].delayMs).toBe(1_000)
    scheduled[1].callback()
    adapters[2].ready()
    await vi.waitFor(() => expect(supervisor.getSnapshot().status).toBe('ready'))

    now = 61_001
    adapters[2].exit()
    expect(scheduled[2].delayMs).toBe(250)
    expect(supervisor.getSnapshot().status).toBe('recovering')
  })

  it('drops duplicate event sequences and isolates listener failures', async () => {
    const adapter = new FakeAdapter()
    const supervisor = new NativeRuntimeSupervisor({
      runtime: 'hotkey',
      createAdapter: () => adapter,
    })
    const stateListener = vi.fn()
    supervisor.onStateChange(() => {
      throw new Error('broken state observer')
    })
    supervisor.onStateChange(stateListener)
    const eventListener = vi.fn()
    supervisor.onEvent(() => {
      throw new Error('broken event observer')
    })
    supervisor.onEvent(eventListener)

    const start = supervisor.start()
    adapter.ready()
    await start
    expect(stateListener).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'ready' }),
    )

    const inputEvent = (sequence: number, code: string) => ({
      type: 'event',
      event: {
        type: 'input',
        sequence,
        input: {
          type: 'inputDown',
          source: 'keyboard',
          code,
          label: code,
          pressedCodes: [code],
        },
      },
    })
    adapter.callbacks?.onMessage(inputEvent(2, 'KeyA'))
    adapter.callbacks?.onMessage(inputEvent(2, 'Duplicate'))
    adapter.callbacks?.onMessage(inputEvent(1, 'Older'))
    adapter.callbacks?.onMessage(inputEvent(3, 'KeyB'))

    expect(eventListener.mock.calls.map(([event]) => event.input.code)).toEqual([
      'KeyA',
      'KeyB',
    ])
  })

  it('delivers telemetry without advancing the control event sequence fence', async () => {
    const adapter = new FakeAdapter()
    const supervisor = new NativeRuntimeSupervisor({
      runtime: 'media',
      createAdapter: () => adapter,
    })
    const eventListener = vi.fn()
    supervisor.onEvent(eventListener)

    const start = supervisor.start()
    adapter.ready(MEDIA_READY)
    await start

    adapter.callbacks?.onMessage({
      type: 'event',
      event: {
        type: 'microphoneMetrics',
        sequence: 10,
        metrics: { revision: 1, inputDb: -30, thresholdDb: -28, open: false },
      },
    })
    adapter.callbacks?.onMessage({
      type: 'event',
      event: {
        type: 'runtimeError',
        sequence: 9,
        error: {
          code: 'test_control_event',
          message: 'control event after telemetry',
          retryable: false,
          stage: 'test',
        },
      },
    })

    expect(eventListener.mock.calls.map(([event]) => event.type)).toEqual([
      'microphoneMetrics',
      'runtimeError',
    ])
  })

  it('records each screen backend recovery counter advance once', async () => {
    const adapter = new FakeAdapter()
    const diagnostics: Array<Record<string, unknown>> = []
    const supervisor = new NativeRuntimeSupervisor({
      runtime: 'media',
      createAdapter: () => adapter,
      diagnostics: (record) => diagnostics.push(record),
    })
    const start = supervisor.start()
    adapter.ready(MEDIA_READY)
    await start

    const sendStats = (sequence: number, count: number) => {
      adapter.callbacks?.onMessage({
        type: 'event',
        event: {
          type: 'stats',
          sequence,
          sessionId: 'screen-a',
          generation: 3,
          stats: {
            sessionId: 'screen-a',
            methods: { wgc_gpu: 1, dxgi_gpu: 1 },
            videoRecoverableLostCount: count,
          },
        },
      })
    }
    sendStats(1, 1)
    sendStats(2, 1)
    sendStats(3, 2)

    expect(
      diagnostics.filter((record) => record.event === 'screen_backend_restart'),
    ).toEqual([
      expect.objectContaining({
        lane: 'screen',
        sessionId: 'screen-a',
        generation: 3,
        message: 'recoverable_lost_count=1',
      }),
      expect.objectContaining({
        lane: 'screen',
        sessionId: 'screen-a',
        generation: 3,
        message: 'recoverable_lost_count=2',
      }),
    ])
  })

  it('records a typed screen recovery before an immediate terminal exactly once', async () => {
    const adapter = new FakeAdapter()
    const diagnostics: Array<Record<string, unknown>> = []
    const supervisor = new NativeRuntimeSupervisor({
      runtime: 'media',
      createAdapter: () => adapter,
      diagnostics: (record) => diagnostics.push(record),
    })
    const start = supervisor.start()
    adapter.ready(MEDIA_READY)
    await start

    adapter.callbacks?.onMessage({
      type: 'event',
      event: {
        type: 'screenBackendRestart',
        sequence: 1,
        sessionId: 'screen-terminal',
        generation: 4,
        backend: 'wgc_gpu',
        reason: 'switch_backend',
        count: 1,
        errorCode: 'gpu_access_lost',
        hresult: -2_007_270_521,
      },
    })
    adapter.callbacks?.onMessage({
      type: 'event',
      event: {
        type: 'screenCaptureEnded',
        sequence: 2,
        sessionId: 'screen-terminal',
        generation: 4,
        reason: 'gpu_capture_unavailable',
      },
    })

    expect(
      diagnostics.filter((record) => record.event === 'screen_backend_restart'),
    ).toEqual([
      expect.objectContaining({
        lane: 'screen',
        sessionId: 'screen-terminal',
        generation: 4,
        kind: 'wgc_gpu',
        reason: 'switch_backend',
        errorCode: 'gpu_access_lost',
        hresult: -2_007_270_521,
        restartCount: 1,
      }),
    ])
  })

  it('keeps active speaker delivery independent from the control sequence fence', async () => {
    const adapter = new FakeAdapter()
    const supervisor = new NativeRuntimeSupervisor({
      runtime: 'media',
      createAdapter: () => adapter,
    })
    const eventListener = vi.fn()
    supervisor.onEvent(eventListener)

    const start = supervisor.start()
    adapter.ready(MEDIA_READY)
    await start

    adapter.callbacks?.onMessage({
      type: 'event',
      event: {
        type: 'activeSpeakers',
        sequence: 10,
        sessionId: 'voice-a',
        generation: 1,
        participantIdentities: ['participant-a'],
      },
    })
    adapter.callbacks?.onMessage({
      type: 'event',
      event: {
        type: 'runtimeError',
        sequence: 9,
        error: {
          code: 'control_after_active_speakers',
          message: 'control lane is independently ordered',
          retryable: false,
          stage: 'test',
        },
      },
    })

    expect(eventListener.mock.calls.map(([event]) => event.type)).toEqual([
      'activeSpeakers',
      'runtimeError',
    ])
  })

  it('keeps lossy frame delivery independent from the control sequence fence', async () => {
    const adapter = new FakeAdapter()
    const supervisor = new NativeRuntimeSupervisor({
      runtime: 'media',
      createAdapter: () => adapter,
    })
    const eventListener = vi.fn()
    supervisor.onEvent(eventListener)

    const start = supervisor.start()
    adapter.ready(MEDIA_READY)
    await start
    adapter.callbacks?.onMessage({
      type: 'event',
      event: {
        type: 'remoteVideoFrame',
        sequence: 10,
        sessionId: 'epoch-a',
        generation: 1,
        trackId: 'track-a',
        participantIdentity: 'participant-a',
        source: 'camera',
        frameSequence: 1,
        timestampUs: 1,
        width: 1280,
        height: 720,
        ntHandle: new Uint8Array(8),
      },
    })
    adapter.callbacks?.onMessage({
      type: 'event',
      event: {
        type: 'runtimeError',
        sequence: 9,
        error: {
          code: 'control_after_frame',
          message: 'control lane is independently ordered',
          retryable: false,
        },
      },
    })

    expect(eventListener.mock.calls.map(([event]) => event.type)).toEqual([
      'remoteVideoFrame',
      'runtimeError',
    ])
  })

  it('rejects a synchronous initial start failure and schedules recovery once', async () => {
    const adapter = new FakeAdapter()
    adapter.startError = new Error('load failed')
    const scheduled: Array<() => void> = []
    const supervisor = new NativeRuntimeSupervisor({
      runtime: 'hotkey',
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
    expect(supervisor.getSnapshot().failure).toMatchObject({
      cause: 'spawn_failed',
      retryable: true,
    })
    expect(scheduled).toHaveLength(1)
  })

  it('treats a synchronous exit during start as one terminal host epoch', async () => {
    const adapter = new FakeAdapter()
    const scheduled: Array<() => void> = []
    adapter.start = (callbacks) => {
      adapter.callbacks = callbacks
      callbacks.onExit({ code: 1 })
      throw new Error('start unwound after exit')
    }
    const supervisor = new NativeRuntimeSupervisor({
      runtime: 'hotkey',
      createAdapter: () => adapter,
      schedule: (callback) => {
        scheduled.push(callback)
        return 1 as unknown as ReturnType<typeof setTimeout>
      },
    })

    await expect(supervisor.start()).rejects.toMatchObject({
      detail: { code: 'runtime_lost' },
    })
    expect(scheduled).toHaveLength(1)
    expect(supervisor.getSnapshot()).toMatchObject({
      status: 'recovering',
      hostEpoch: 1,
      failure: { cause: 'process_exit' },
    })
  })

  it('fences a timed-out handshake and ignores late ready from that epoch', async () => {
    vi.useFakeTimers()
    const adapters: FakeAdapter[] = []
    const scheduled: Array<() => void> = []
    const supervisor = new NativeRuntimeSupervisor({
      runtime: 'hotkey',
      createAdapter: () => {
        const adapter = new FakeAdapter()
        adapters.push(adapter)
        return adapter
      },
      handshakeTimeoutMs: 5,
      schedule: (callback) => {
        scheduled.push(callback)
        return scheduled.length as unknown as ReturnType<typeof setTimeout>
      },
    })

    const start = supervisor.start()
    const failedStart = expect(start).rejects.toMatchObject({
      detail: { code: 'handshake_failed', retryable: true },
    })
    await vi.advanceTimersByTimeAsync(5)
    await failedStart
    expect(supervisor.getSnapshot()).toMatchObject({
      status: 'recovering',
      hostEpoch: 1,
      failure: { cause: 'handshake_timeout' },
    })

    adapters[0].ready()
    expect(supervisor.getSnapshot().status).toBe('recovering')
    scheduled[0]()
    adapters[1].ready()
    await vi.waitFor(() => expect(supervisor.getSnapshot()).toMatchObject({
      status: 'ready',
      hostEpoch: 2,
    }))
    vi.useRealTimers()
  })

  it('publishes starting only after reentrant start is fenced by the same promise', async () => {
    const adapters: FakeAdapter[] = []
    const supervisor = new NativeRuntimeSupervisor({
      runtime: 'hotkey',
      createAdapter: () => {
        const adapter = new FakeAdapter()
        adapters.push(adapter)
        return adapter
      },
    })
    let reentrantStart: Promise<NativeRuntimeReady> | null = null
    supervisor.onStateChange((snapshot) => {
      if (snapshot.status === 'starting') reentrantStart = supervisor.start()
    })

    const start = supervisor.start()
    expect(adapters).toHaveLength(1)
    expect(reentrantStart).toBe(start)
    adapters[0].ready()
    await expect(start).resolves.toEqual(READY)
  })

  it('does not spawn a host after a starting observer shuts the supervisor down', async () => {
    const adapters: FakeAdapter[] = []
    const supervisor = new NativeRuntimeSupervisor({
      runtime: 'hotkey',
      createAdapter: () => {
        const adapter = new FakeAdapter()
        adapters.push(adapter)
        return adapter
      },
    })
    let shutdown: Promise<void> | null = null
    supervisor.onStateChange((snapshot) => {
      if (snapshot.status === 'starting') shutdown = supervisor.shutdown()
    })

    const start = supervisor.start()
    await expect(start).rejects.toMatchObject({
      detail: { code: 'runtime_stopped' },
    })
    await shutdown
    expect(adapters).toHaveLength(0)
    expect(supervisor.getSnapshot().status).toBe('stopped')
  })

  it('uses every configured restart delay before opening the crash circuit', async () => {
    const adapters: FakeAdapter[] = []
    const scheduled: Array<() => void> = []
    const supervisor = new NativeRuntimeSupervisor({
      runtime: 'hotkey',
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
    scheduled.shift()?.()
    await vi.waitFor(() => expect(adapters).toHaveLength(4))
    const fourth = adapters[3]
    fourth.ready()
    await vi.waitFor(() => expect(supervisor.getSnapshot().status).toBe('ready'))
    fourth.exit()

    expect(supervisor.getSnapshot()).toMatchObject({
      status: 'degraded',
      restartCount: 3,
    })
  })

  it('automatically retries a circuit-open runtime after the degraded backoff', async () => {
    const adapters: FakeAdapter[] = []
    const scheduled: Array<{ callback(): void; delayMs: number }> = []
    const supervisor = new NativeRuntimeSupervisor({
      runtime: 'hotkey',
      createAdapter: () => {
        const adapter = new FakeAdapter()
        adapters.push(adapter)
        return adapter
      },
      now: () => 1_000,
      schedule: (callback, delayMs) => {
        scheduled.push({ callback, delayMs })
        return scheduled.length as unknown as ReturnType<typeof setTimeout>
      },
    })

    const initial = supervisor.start()
    adapters[0].ready()
    await initial
    for (let index = 0; index < 3; index += 1) {
      adapters[index].exit()
      const restart = scheduled.shift()
      expect(restart?.delayMs).toBe([250, 1_000, 5_000][index])
      restart?.callback()
      adapters[index + 1].ready()
      await vi.waitFor(() => expect(supervisor.getSnapshot().status).toBe('ready'))
    }
    adapters[3].exit()

    expect(supervisor.getSnapshot()).toMatchObject({
      status: 'degraded',
      degradedRetryAttempt: 1,
      nextRetryAt: 31_000,
      failure: { cause: 'circuit_open', retryable: true },
    })
    const automaticRetry = scheduled.shift()
    expect(automaticRetry?.delayMs).toBe(30_000)
    automaticRetry?.callback()
    expect(adapters).toHaveLength(5)
    adapters[4].ready()
    await vi.waitFor(() => expect(supervisor.getSnapshot().status).toBe('ready'))
    expect(supervisor.getSnapshot()).toMatchObject({
      restartCount: 4,
      degradedRetryAttempt: undefined,
      nextRetryAt: undefined,
    })
  })

  it('ignores a cancelled degraded retry callback from an older circuit-open cycle', async () => {
    const adapters: FakeAdapter[] = []
    const scheduled: Array<{ callback(): void; delayMs: number }> = []
    const supervisor = new NativeRuntimeSupervisor({
      runtime: 'hotkey',
      createAdapter: () => {
        const adapter = new FakeAdapter()
        adapters.push(adapter)
        return adapter
      },
      now: () => 1_000,
      schedule: (callback, delayMs) => {
        scheduled.push({ callback, delayMs })
        return scheduled.length as unknown as ReturnType<typeof setTimeout>
      },
    })
    const crashUntilDegraded = async () => {
      for (let index = 0; index < 3; index += 1) {
        adapters.at(-1)?.exit()
        const restart = scheduled.shift()
        expect(restart?.delayMs).toBe([250, 1_000, 5_000][index])
        restart?.callback()
        adapters.at(-1)?.ready()
        await vi.waitFor(() =>
          expect(supervisor.getSnapshot().status).toBe('ready'),
        )
      }
      adapters.at(-1)?.exit()
      await vi.waitFor(() =>
        expect(supervisor.getSnapshot().status).toBe('degraded'),
      )
    }

    const initial = supervisor.start()
    adapters[0].ready()
    await initial
    await crashUntilDegraded()
    const staleRetry = scheduled.shift()
    expect(staleRetry?.delayMs).toBe(30_000)

    const manualRetry = supervisor.retry()
    adapters.at(-1)?.ready()
    await manualRetry
    await crashUntilDegraded()
    const currentRetry = scheduled.shift()
    expect(currentRetry?.delayMs).toBe(30_000)

    const adapterCount = adapters.length
    staleRetry?.callback()
    expect(adapters).toHaveLength(adapterCount)
    expect(supervisor.getSnapshot().status).toBe('degraded')

    currentRetry?.callback()
    expect(adapters).toHaveLength(adapterCount + 1)
  })

  it('allows the default 2.5-second actor probe deadline', async () => {
    vi.useFakeTimers()
    try {
      const adapter = new FakeAdapter()
      const supervisor = new NativeRuntimeSupervisor({
        runtime: 'media',
        createAdapter: () => adapter,
      })
      const start = supervisor.start()
      adapter.ready(MEDIA_READY)
      await start

      const request = supervisor.request({ type: 'listDevices', kind: 'audioinput' }, 10)
      const rejection = expect(request).rejects.toMatchObject({
        detail: { code: 'request_timeout' },
      })
      await vi.advanceTimersByTimeAsync(10)
      await rejection
      expect(
        adapter.requests.some(
          (item) => item.command.type === 'probeQueryWorker',
        ),
      ).toBe(true)

      await vi.advanceTimersByTimeAsync(2_499)
      expect(adapter.killed).toBe(false)
      await vi.advanceTimersByTimeAsync(1)
      expect(adapter.killed).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })

  it('rejects a mismatched contract without a restart loop', async () => {
    const adapter = new FakeAdapter()
    const supervisor = new NativeRuntimeSupervisor({
      runtime: 'hotkey',
      createAdapter: () => adapter,
    })
    const start = supervisor.start()
    adapter.callbacks?.onMessage({ ...READY, contractVersion: 999 })
    await expect(start).rejects.toBeInstanceOf(NativeRuntimeRequestError)
    expect(supervisor.getSnapshot()).toMatchObject({
      status: 'degraded',
      failure: {
        cause: 'handshake_incompatible',
        retryable: false,
      },
    })
  })

  it('rejects an addon with missing runtime identity without starting workers', async () => {
    const adapters: FakeAdapter[] = []
    const supervisor = new NativeRuntimeSupervisor({
      runtime: 'hotkey',
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

  it('rejects only the timed-out request and probes the affected hooks lane before recycling', async () => {
    const adapter = new FakeAdapter()
    const scheduled: Array<() => void> = []
    vi.useFakeTimers()
    const supervisor = new NativeRuntimeSupervisor({
      runtime: 'hotkey',
      createAdapter: () => adapter,
      probeTimeoutMs: 10,
      schedule: (callback) => {
        scheduled.push(callback)
        return 1 as unknown as ReturnType<typeof setTimeout>
      },
    })
    const start = supervisor.start()
    adapter.ready()
    await start

    const timedOut = supervisor.request({ type: 'startHotkeys' }, 5)
    const collateral = supervisor.request({ type: 'startOverlay' }, 1_000)
    const timedOutExpectation = expect(timedOut).rejects.toMatchObject({
      detail: {
        code: 'request_timeout',
        stage: 'startHotkeys',
      },
    })
    await vi.advanceTimersByTimeAsync(5)
    await timedOutExpectation
    expect(adapter.requests.map((request) => request.command.type)).toEqual([
      'startHotkeys',
      'startOverlay',
      'probeHooksRuntime',
    ])
    expect(adapter.killed).toBe(false)
    adapter.replyByType('probeHooksRuntime')
    adapter.replyByType('startOverlay', { started: true })
    await expect(collateral).resolves.toEqual({ started: true })
    expect(supervisor.getSnapshot().status).toBe('ready')
    expect(scheduled).toHaveLength(0)
    vi.useRealTimers()
  })

  it('preserves session context and probes the actor without recycling voice', async () => {
    const adapter = new FakeAdapter()
    const diagnostics: Array<Record<string, unknown>> = []
    const supervisor = new NativeRuntimeSupervisor({
      runtime: 'media',
      createAdapter: () => adapter,
      schedule: () => 1 as unknown as ReturnType<typeof setTimeout>,
      diagnostics: (record) => diagnostics.push(record),
    })
    const start = supervisor.start()
    adapter.ready(MEDIA_READY)
    await start

    await expect(
      supervisor.request(
        {
          type: 'disconnectMicrophone',
          sessionId: 'microphone-a',
          generation: 7,
        },
        5,
      ),
    ).rejects.toMatchObject({
      detail: {
        code: 'request_timeout',
        stage: 'disconnectMicrophone',
        sessionId: 'microphone-a',
        generation: 7,
      },
    })
    expect(diagnostics).toContainEqual(
      expect.objectContaining({
        scope: 'native-runtime-supervisor',
        event: 'request_timed_out',
        runtime: 'media',
        stage: 'disconnectMicrophone',
        sessionId: 'microphone-a',
        generation: 7,
        timeoutMs: 5,
        durationMs: expect.any(Number),
      }),
    )
    expect(adapter.requests.map((request) => request.command.type)).toContain(
      'probeMicrophoneActor',
    )
    expect(adapter.killed).toBe(false)
    adapter.replyByType('probeMicrophoneActor', { state: 'available' })
    expect(supervisor.getSnapshot().status).toBe('ready')
  })

  it('keeps a slow microphone operation healthy when its independent probe replies', async () => {
    vi.useFakeTimers()
    const adapter = new FakeAdapter()
    const diagnostics: Array<Record<string, unknown>> = []
    const supervisor = new NativeRuntimeSupervisor({
      runtime: 'media',
      createAdapter: () => adapter,
      diagnostics: (record) => diagnostics.push(record),
    })
    const start = supervisor.start()
    adapter.ready(MEDIA_READY)
    await start

    const configure = supervisor.request(
      {
        type: 'configureMicrophone',
        revision: 1,
        config: {
          deviceId: null,
          bypassSystemAudioInputProcessing: true,
          automaticGainControl: true,
          noiseSuppression: true,
          echoCancellation: false,
          inputVolume: 1,
          voiceGateEnabled: true,
          voiceGateThresholdDb: -28,
          voiceGateAutoThreshold: true,
        },
      },
      5_000,
    )
    const configureFailure = expect(configure).rejects.toMatchObject({
      detail: { code: 'request_timeout', stage: 'configureMicrophone' },
    })
    await vi.advanceTimersByTimeAsync(5_000)
    await configureFailure
    expect(adapter.requests.map(({ command }) => command.type)).toEqual([
      'configureMicrophone',
      'probeMicrophoneActor',
    ])
    await vi.advanceTimersByTimeAsync(2_499)
    expect(adapter.killed).toBe(false)
    adapter.replyByType('probeMicrophoneActor', { state: 'available' })
    await vi.runAllTicks()
    expect(adapter.killed).toBe(false)
    expect(diagnostics).not.toContainEqual(
      expect.objectContaining({ event: 'liveness_probe_failed' }),
    )
    vi.useRealTimers()
  })

  it('records an actual camera read watchdog timeout as an incident', async () => {
    const adapter = new FakeAdapter()
    const diagnostics: Array<Record<string, unknown>> = []
    const supervisor = new NativeRuntimeSupervisor({
      runtime: 'media',
      createAdapter: () => adapter,
      diagnostics: (record) => diagnostics.push(record),
    })
    const start = supervisor.start()
    adapter.ready(MEDIA_READY)
    await start

    adapter.callbacks?.onMessage({
      type: 'event',
      event: {
        type: 'cameraTerminal',
        sequence: 1,
        sessionId: 'camera-a',
        generation: 7,
        error: {
          code: 'camera_read_stall',
          message: 'Camera stopped delivering asynchronous samples',
          stage: 'connectCamera',
          retryable: true,
          sessionId: 'camera-a',
          generation: 7,
        },
      },
    })

    expect(diagnostics).toContainEqual(
      expect.objectContaining({
        scope: 'native-runtime-supervisor',
        event: 'camera_read_stall',
        runtime: 'media',
        lane: 'camera',
        nativeEventType: 'cameraTerminal',
        nativeSequence: 1,
        sessionId: 'camera-a',
        generation: 7,
        stage: 'connectCamera',
        errorCode: 'camera_read_stall',
      }),
    )
  })

  it('recycles only after the lane probe also times out and then rejects collateral work', async () => {
    const adapter = new FakeAdapter()
    vi.useFakeTimers()
    const supervisor = new NativeRuntimeSupervisor({
      runtime: 'hotkey',
      createAdapter: () => adapter,
      probeTimeoutMs: 10,
      schedule: () => 1 as unknown as ReturnType<typeof setTimeout>,
    })
    const start = supervisor.start()
    adapter.ready()
    await start

    const timedOut = supervisor.request({ type: 'startHotkeys' }, 5)
    const collateral = supervisor.request({ type: 'startOverlay' }, 1_000)
    const timedOutExpectation = expect(timedOut).rejects.toMatchObject({
      detail: { code: 'request_timeout', stage: 'startHotkeys' },
    })
    const collateralExpectation = expect(collateral).rejects.toMatchObject({
      detail: {
        code: 'runtime_lost',
        message: 'Native runtime recycled after an actor liveness probe timed out',
        stage: 'startOverlay',
      },
    })
    await vi.advanceTimersByTimeAsync(5)

    await timedOutExpectation
    expect(adapter.killed).toBe(false)
    await vi.advanceTimersByTimeAsync(10)
    await collateralExpectation
    expect(adapter.killed).toBe(true)
    expect(supervisor.getSnapshot().failure).toMatchObject({
      cause: 'liveness_probe_failed',
    })
    vi.useRealTimers()
  })

  it('recycles immediately when an actor reports that its bounded capacity is lost', async () => {
    const adapter = new FakeAdapter()
    const supervisor = new NativeRuntimeSupervisor({
      runtime: 'media',
      createAdapter: () => adapter,
      schedule: () => 1 as unknown as ReturnType<typeof setTimeout>,
    })
    const start = supervisor.start()
    adapter.ready(MEDIA_READY)
    await start

    const request = supervisor.request({ type: 'probeScreenActor' }, 1_000)
    await vi.waitFor(() => expect(adapter.requests).toHaveLength(1))
    adapter.replyError(0, 'actor_unresponsive')

    await expect(request).rejects.toMatchObject({
      detail: { code: 'actor_unresponsive' },
    })
    expect(adapter.killed).toBe(true)
    expect(supervisor.getSnapshot().status).toBe('recovering')
    expect(supervisor.getSnapshot().failure).toMatchObject({
      cause: 'actor_unresponsive',
    })
  })

  it('labels an uncertain mutating timeout without parsing its message', async () => {
    const adapter = new FakeAdapter()
    vi.useFakeTimers()
    const supervisor = new NativeRuntimeSupervisor({
      runtime: 'media',
      createAdapter: () => adapter,
      schedule: () => 1 as unknown as ReturnType<typeof setTimeout>,
    })
    const start = supervisor.start()
    adapter.ready(MEDIA_READY)
    await start

    const request = supervisor.request({
      type: 'connectVoice',
      sessionId: 'voice-a',
      generation: 1,
      options: {
        livekit: {
          url: 'wss://voice.invalid',
          token: 'token-a',
          participantIdentity: 'participant-a',
        },
      },
    }, 5)
    const expectation = expect(request).rejects.toMatchObject({
      detail: { code: 'request_timeout' },
    })
    await vi.advanceTimersByTimeAsync(5)
    await expectation

    expect(adapter.killed).toBe(true)
    expect(supervisor.getSnapshot().failure).toMatchObject({
      cause: 'request_outcome_unknown',
    })
    vi.useRealTimers()
  })

  it('coalesces concurrent query timeouts into one lane probe', async () => {
    const adapter = new FakeAdapter()
    vi.useFakeTimers()
    const supervisor = new NativeRuntimeSupervisor({
      runtime: 'media',
      createAdapter: () => adapter,
      probeTimeoutMs: 10,
      schedule: () => 1 as unknown as ReturnType<typeof setTimeout>,
    })
    const start = supervisor.start()
    adapter.ready(MEDIA_READY)
    await start

    const first = supervisor.request(
      { type: 'listDevices', kind: 'audioinput' },
      5,
    )
    const firstExpectation = expect(first).rejects.toMatchObject({
      detail: { code: 'request_timeout' },
    })
    const second = supervisor.request(
      { type: 'listDisplaySources' },
      5,
    )
    const secondExpectation = expect(second).rejects.toMatchObject({
      detail: { code: 'request_timeout' },
    })
    await vi.advanceTimersByTimeAsync(5)
    await firstExpectation
    await secondExpectation

    expect(
      adapter.requests.filter(
        (request) => request.command.type === 'probeQueryWorker',
      ),
    ).toHaveLength(1)
    vi.useRealTimers()
  })

  it('keeps probing a background retirement until lost capacity recycles the host', async () => {
    const adapter = new FakeAdapter()
    vi.useFakeTimers()
    const supervisor = new NativeRuntimeSupervisor({
      runtime: 'media',
      createAdapter: () => adapter,
      probeTimeoutMs: 100,
      schedule: () => 1 as unknown as ReturnType<typeof setTimeout>,
    })
    const start = supervisor.start()
    adapter.ready(MEDIA_READY)
    await start

    const stop = supervisor.request(
      {
        type: 'disconnectMicrophone',
        sessionId: 'mic-a',
        generation: 1,
      },
      1_000,
    )
    await vi.waitFor(() => expect(adapter.requests).toHaveLength(1))
    adapter.reply(0, undefined)
    await stop

    await vi.advanceTimersByTimeAsync(1_000)
    expect(adapter.requests[1]?.command.type).toBe('probeMicrophoneActor')
    adapter.reply(1, { state: 'busy' })
    await Promise.resolve()

    await vi.advanceTimersByTimeAsync(1_000)
    expect(adapter.requests[2]?.command.type).toBe('probeMicrophoneActor')
    adapter.replyError(2, 'actor_unresponsive')
    await Promise.resolve()

    expect(adapter.killed).toBe(true)
    expect(supervisor.getSnapshot().failure).toMatchObject({
      cause: 'actor_unresponsive',
    })
    vi.useRealTimers()
  })

  it('keeps checking a timed-out camera attempt until its actor retires', async () => {
    const adapter = new FakeAdapter()
    vi.useFakeTimers()
    try {
      const supervisor = new NativeRuntimeSupervisor({
        runtime: 'media',
        createAdapter: () => adapter,
        probeTimeoutMs: 100,
        schedule: () => 1 as unknown as ReturnType<typeof setTimeout>,
      })
      const start = supervisor.start()
      adapter.ready(MEDIA_READY)
      await start

      const connect = supervisor.request({
        type: 'connectCamera',
        sessionId: 'voice-a',
        generation: 1,
        options: { participantIdentity: 'participant-a' },
      }, 5)
      const timeout = expect(connect).rejects.toMatchObject({
        detail: { code: 'request_timeout' },
      })
      await vi.advanceTimersByTimeAsync(5)
      await timeout
      expect(adapter.requests[1]?.command.type).toBe('probeCameraActor')

      adapter.reply(1, { state: 'busy' })
      await Promise.resolve()
      await vi.advanceTimersByTimeAsync(1_000)
      expect(adapter.requests[2]?.command.type).toBe('probeCameraActor')
      expect(adapter.killed).toBe(false)
      adapter.reply(2, { state: 'available' })
    } finally {
      vi.useRealTimers()
    }
  })

  it('does not probe behind legitimate work in the same retirement lane', async () => {
    const adapter = new FakeAdapter()
    vi.useFakeTimers()
    try {
      const supervisor = new NativeRuntimeSupervisor({
        runtime: 'media',
        createAdapter: () => adapter,
        probeTimeoutMs: 100,
        schedule: () => 1 as unknown as ReturnType<typeof setTimeout>,
      })
      const start = supervisor.start()
      adapter.ready(MEDIA_READY)
      await start

      const connect = supervisor.request({
        type: 'connectScreen',
        sessionId: 'voice-a',
        generation: 1,
        options: { participantIdentity: 'participant-a' },
      }, 20_000)
      await vi.waitFor(() => expect(adapter.requests).toHaveLength(1))
      adapter.reply(0, undefined)
      await connect

      const capture = supervisor.request({
        type: 'startScreenCapture',
        sessionId: 'voice-a',
        generation: 1,
        excludeProcessId: 42,
        options: {
          kind: 'screen',
          requestId: 'screen-a',
          sourceId: 'screen:1:0',
          participantIdentity: 'participant-a',
        },
      }, 20_000)
      await vi.waitFor(() => expect(adapter.requests).toHaveLength(2))

      await vi.advanceTimersByTimeAsync(1_000)
      expect(adapter.requests).toHaveLength(2)
      expect(adapter.killed).toBe(false)

      adapter.reply(1, undefined)
      await capture
      await vi.advanceTimersByTimeAsync(1_000)
      expect(adapter.requests[2]?.command.type).toBe('probeScreenActor')
    } finally {
      vi.useRealTimers()
    }
  })

  it('does not let a stale probe recycle a replacement adapter', async () => {
    const adapters: FakeAdapter[] = []
    const restarts: Array<() => void> = []
    vi.useFakeTimers()
    const supervisor = new NativeRuntimeSupervisor({
      runtime: 'hotkey',
      createAdapter: () => {
        const adapter = new FakeAdapter()
        adapters.push(adapter)
        return adapter
      },
      probeTimeoutMs: 10,
      schedule: (callback) => {
        restarts.push(callback)
        return restarts.length as unknown as ReturnType<typeof setTimeout>
      },
    })
    const firstStart = supervisor.start()
    adapters[0].ready()
    await firstStart

    const timedOut = supervisor.request({ type: 'startHotkeys' }, 5)
    const timedOutExpectation = expect(timedOut).rejects.toMatchObject({
      detail: { code: 'request_timeout' },
    })
    await vi.advanceTimersByTimeAsync(5)
    await timedOutExpectation
    expect(
      adapters[0].requests.some(
        (request) => request.command.type === 'probeHooksRuntime',
      ),
    ).toBe(true)

    adapters[0].exit()
    const restart = supervisor.start()
    restarts[0]()
    adapters[1].ready()
    await restart

    await vi.advanceTimersByTimeAsync(10)
    expect(adapters[1].killed).toBe(false)
    expect(supervisor.getSnapshot().status).toBe('ready')
    vi.useRealTimers()
  })

  it('recycles a host when structured-clone delivery fails before exit', async () => {
    const adapter = new FakeAdapter()
    const scheduled: Array<() => void> = []
    const supervisor = new NativeRuntimeSupervisor({
      runtime: 'hotkey',
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
    expect(supervisor.getSnapshot().failure).toMatchObject({
      cause: 'transport_error',
    })
    expect(scheduled).toHaveLength(1)
  })

  it('rejects an in-progress handshake during shutdown', async () => {
    const adapter = new FakeAdapter()
    const supervisor = new NativeRuntimeSupervisor({
      runtime: 'hotkey',
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
      runtime: 'hotkey',
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

  it('does not overlap a new start with graceful shutdown', async () => {
    const adapter = new FakeAdapter()
    const supervisor = new NativeRuntimeSupervisor({
      runtime: 'hotkey',
      createAdapter: () => adapter,
    })
    const start = supervisor.start()
    adapter.ready()
    await start

    const shutdown = supervisor.shutdown()
    await vi.waitFor(() => expect(adapter.requests).toHaveLength(1))
    await expect(supervisor.start()).rejects.toMatchObject({
      detail: { code: 'runtime_stopped' },
    })
    adapter.reply(0, undefined)
    adapter.exit(0)
    await shutdown

    expect(supervisor.getSnapshot().status).toBe('stopped')
  })

  it('joins reentrant shutdown calls from stopped observers', async () => {
    const supervisor = new NativeRuntimeSupervisor({
      runtime: 'hotkey',
      createAdapter: () => new FakeAdapter(),
    })
    let reentrantShutdown: Promise<void> | null = null
    let stoppedNotifications = 0
    supervisor.onStateChange((snapshot) => {
      if (snapshot.status !== 'stopped') return
      stoppedNotifications += 1
      reentrantShutdown = supervisor.shutdown()
    })

    const shutdown = supervisor.shutdown()
    await shutdown
    await reentrantShutdown

    expect(reentrantShutdown).toBe(shutdown)
    expect(stoppedNotifications).toBe(1)
    expect(supervisor.getSnapshot().status).toBe('stopped')
  })
})
