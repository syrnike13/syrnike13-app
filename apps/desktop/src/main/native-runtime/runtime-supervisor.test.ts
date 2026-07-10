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

  it('waits for scheduled backoff and resets its delay after the crash window', async () => {
    const adapters: FakeAdapter[] = []
    const scheduled: Array<{ callback(): void; delayMs: number }> = []
    let now = 0
    const supervisor = new NativeRuntimeSupervisor({
      runtime: 'hooks',
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
      runtime: 'hooks',
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

  it('rejects only the timed-out request and probes the affected hooks lane before recycling', async () => {
    const adapter = new FakeAdapter()
    const scheduled: Array<() => void> = []
    vi.useFakeTimers()
    const supervisor = new NativeRuntimeSupervisor({
      runtime: 'hooks',
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

  it('preserves session context on a timed-out media request', async () => {
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
    expect(adapter.killed).toBe(true)
  })

  it('recycles only after the lane probe also times out and then rejects collateral work', async () => {
    const adapter = new FakeAdapter()
    vi.useFakeTimers()
    const supervisor = new NativeRuntimeSupervisor({
      runtime: 'hooks',
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
    vi.useRealTimers()
  })

  it('does not let a stale probe recycle a replacement adapter', async () => {
    const adapters: FakeAdapter[] = []
    const restarts: Array<() => void> = []
    vi.useFakeTimers()
    const supervisor = new NativeRuntimeSupervisor({
      runtime: 'hooks',
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
