import {
  NATIVE_RUNTIME_CONTRACT_VERSION,
  NATIVE_RUNTIME_MAX_PENDING_REQUESTS,
  isNativeRuntimeMessage,
  nativeRuntimeError,
  redactSensitiveText,
  type NativeRuntimeCommand,
  type NativeRuntimeError,
  type NativeRuntimeEvent,
  type NativeRuntimeKind,
  type NativeRuntimeReady,
  type NativeRuntimeRequest,
} from './contract'
import type { DiagnosticLogSink } from './diagnostic-log'
import type {
  NativeRuntimeAdapter,
  NativeRuntimeAdapterExit,
  NativeRuntimeAdapterFactory,
} from './utility-adapter'

const DEFAULT_HANDSHAKE_TIMEOUT_MS = 5_000
const DEFAULT_PROBE_TIMEOUT_MS = 1_000
const RETIREMENT_WATCHDOG_INTERVAL_MS = 1_000
const RESTART_DELAYS_MS = [250, 1_000, 5_000] as const
const CRASH_WINDOW_MS = 60_000

export type NativeRuntimeSupervisorStatus =
  | 'stopped'
  | 'starting'
  | 'ready'
  | 'recovering'
  | 'degraded'

export type NativeRuntimeFailureCause =
  | 'spawn_failed'
  | 'handshake_timeout'
  | 'handshake_incompatible'
  | 'process_exit'
  | 'transport_error'
  | 'request_outcome_unknown'
  | 'actor_unresponsive'
  | 'liveness_probe_failed'
  | 'circuit_open'

export type NativeRuntimeFailure = {
  cause: NativeRuntimeFailureCause
  message: string
  retryable: boolean
}

export type NativeRuntimeSupervisorSnapshot = {
  runtime: NativeRuntimeKind
  status: NativeRuntimeSupervisorStatus
  pid?: number
  restartCount: number
  /** Monotonic identity of the utility host whose state is being reported. */
  hostEpoch?: number
  failure?: NativeRuntimeFailure
  degradedReason?: string
  lastFailure?: string
  ready?: NativeRuntimeReady
}

export type NativeRuntimeGenerationLane =
  | 'voice'
  | 'microphone'
  | 'screen'
  | 'camera'

export class NativeRuntimeRequestError extends Error {
  constructor(readonly detail: NativeRuntimeError) {
    super(detail.message)
    this.name = 'NativeRuntimeRequestError'
  }
}

type PendingRequest = {
  resolve(value: unknown): void
  reject(error: Error): void
  timeout: ReturnType<typeof setTimeout>
  context: NativeRuntimeRequestContext
  startedAt: number
  kind: 'command' | 'probe'
  probeKey?: string
  adapterEpoch: number
}

type NativeRuntimeRequestContext = {
  stage: NativeRuntimeCommand['type']
  lane?: NativeRuntimeLane
  sessionId?: string
  generation?: number
}

type NativeRuntimeLane =
  | 'voice'
  | 'microphone'
  | 'screen'
  | 'camera'
  | 'query'
  | 'hotkey'
  | 'overlay'

function requestContext(
  command: NativeRuntimeCommand,
): NativeRuntimeRequestContext {
  return {
    stage: command.type,
    lane: requestLane(command),
    sessionId:
      'sessionId' in command && typeof command.sessionId === 'string'
        ? command.sessionId
        : undefined,
    generation:
      'generation' in command && typeof command.generation === 'number'
        ? command.generation
        : undefined,
  }
}

export type NativeRuntimeSupervisorOptions = {
  runtime: NativeRuntimeKind
  createAdapter: NativeRuntimeAdapterFactory
  handshakeTimeoutMs?: number
  probeTimeoutMs?: number
  now?: () => number
  schedule?: (callback: () => void, delayMs: number) => ReturnType<typeof setTimeout>
  diagnostics?: DiagnosticLogSink
}

type NativeRuntimeRequestOptions = {
  probeOnTimeout?: boolean
  allowDuringShutdown?: boolean
}

export class NativeRuntimeSupervisor {
  private adapter: NativeRuntimeAdapter | null = null
  private snapshot: NativeRuntimeSupervisorSnapshot
  private readonly pending = new Map<string, PendingRequest>()
  private readonly eventListeners = new Set<(event: NativeRuntimeEvent) => void>()
  private readonly stateListeners = new Set<
    (snapshot: NativeRuntimeSupervisorSnapshot) => void
  >()
  private startPromise: Promise<NativeRuntimeReady> | null = null
  private resolveStart: ((ready: NativeRuntimeReady) => void) | null = null
  private rejectStart: ((error: Error) => void) | null = null
  private handshakeTimer: ReturnType<typeof setTimeout> | null = null
  private restartTimer: ReturnType<typeof setTimeout> | null = null
  private crashTimes: number[] = []
  private expectedExitEpoch: number | null = null
  private startEpoch: number | null = null
  private restartScheduleEpoch = 0
  private shutdownPromise: Promise<void> | null = null
  private requestSequence = 0
  private adapterEpoch = 0
  // Native generation fences outlive account-scoped RTC adapters, so their
  // sequence source must share the supervisor's runtime lifetime.
  private readonly generationSequences: Record<
    NativeRuntimeGenerationLane,
    number
  > = {
    voice: 0,
    microphone: 0,
    screen: 0,
    camera: 0,
  }
  private microphoneConfigRevision = 0
  private lastControlEventSequence = -1
  private readonly activeProbeKeys = new Set<string>()
  private readonly retirementWatchdogs = new Map<
    NativeRuntimeLane,
    ReturnType<typeof setTimeout>
  >()

  constructor(private readonly options: NativeRuntimeSupervisorOptions) {
    this.snapshot = {
      runtime: options.runtime,
      status: 'stopped',
      restartCount: 0,
    }
  }

  getSnapshot() {
    return { ...this.snapshot }
  }

  getPendingRequestCount() {
    return this.pending.size
  }

  allocateGeneration(lane: NativeRuntimeGenerationLane) {
    const generation = this.generationSequences[lane] + 1
    assertSafeSequence(generation, `${lane} generation`)
    this.generationSequences[lane] = generation
    return generation
  }

  allocateMicrophoneConfigRevision() {
    const revision = this.microphoneConfigRevision + 1
    assertSafeSequence(revision, 'microphone config revision')
    this.microphoneConfigRevision = revision
    return revision
  }

  onEvent(listener: (event: NativeRuntimeEvent) => void) {
    this.eventListeners.add(listener)
    return () => this.eventListeners.delete(listener)
  }

  onStateChange(listener: (snapshot: NativeRuntimeSupervisorSnapshot) => void) {
    this.stateListeners.add(listener)
    return () => this.stateListeners.delete(listener)
  }

  start() {
    if (this.shutdownPromise) {
      return Promise.reject(
        new NativeRuntimeRequestError(
          nativeRuntimeError('runtime_stopped', 'Native runtime is stopping'),
        ),
      )
    }
    if (this.snapshot.status === 'ready' && this.snapshot.ready) {
      return Promise.resolve(this.snapshot.ready)
    }
    if (this.startPromise) return this.startPromise
    if (this.restartTimer) return this.waitForScheduledStart()
    if (this.snapshot.status === 'degraded') {
      return Promise.reject(
        new NativeRuntimeRequestError(
          nativeRuntimeError(
            'runtime_degraded',
            this.snapshot.degradedReason ?? 'Native runtime is degraded',
          ),
        ),
      )
    }

    this.expectedExitEpoch = null
    const adapterEpoch = ++this.adapterEpoch
    this.startEpoch = adapterEpoch
    const startPromise = new Promise<NativeRuntimeReady>((resolve, reject) => {
      this.resolveStart = resolve
      this.rejectStart = reject
    })
    this.startPromise = startPromise
    this.log('start_requested', {
      status: this.snapshot.status,
      restartCount: this.snapshot.restartCount,
      pendingCount: this.pending.size,
    })
    this.updateSnapshot({
      status: this.snapshot.restartCount > 0 ? 'recovering' : 'starting',
      degradedReason: undefined,
      lastFailure: undefined,
      failure: undefined,
      ready: undefined,
      hostEpoch: adapterEpoch,
    })
    if (this.startEpoch !== adapterEpoch) return startPromise

    let adapter: NativeRuntimeAdapter | null = null
    try {
      const createdAdapter = this.options.createAdapter()
      adapter = createdAdapter
      this.adapter = createdAdapter
      this.lastControlEventSequence = -1
      this.log('adapter_created', {
        pendingCount: this.pending.size,
      })
      this.handshakeTimer = setTimeout(
        () => this.failHandshake(
          createdAdapter,
          adapterEpoch,
          failure('handshake_timeout', 'Native runtime handshake timed out'),
        ),
        this.options.handshakeTimeoutMs ?? DEFAULT_HANDSHAKE_TIMEOUT_MS,
      )
      this.log('handshake_started', {
        pendingCount: this.pending.size,
      })
      createdAdapter.start({
        onMessage: (message) => this.handleMessage(createdAdapter, adapterEpoch, message),
        onExit: (exit) => this.handleExit(createdAdapter, adapterEpoch, exit),
      })
      if (!this.isCurrentHost(createdAdapter, adapterEpoch)) return startPromise
      this.updateSnapshot({ pid: createdAdapter.pid })
      this.log('adapter_started', {
        adapterPid: createdAdapter.pid,
        pendingCount: this.pending.size,
      })
    } catch (error) {
      const message = error instanceof Error
        ? error.message
        : 'Native runtime failed to start'
      const activeAdapter = this.adapter
      const activeEpoch = this.adapterEpoch
      if (adapter && activeAdapter === adapter) {
        this.failHandshake(
          activeAdapter,
          activeEpoch,
          failure('spawn_failed', message),
        )
      } else if (!adapter) {
        this.failStartWithoutHost(failure('spawn_failed', message))
      }
    }
    return startPromise
  }

  async request<T = unknown>(
    command: NativeRuntimeCommand,
    timeoutMs: number,
    options: NativeRuntimeRequestOptions = {},
  ): Promise<T> {
    const context = requestContext(command)
    this.log('request_start', {
      ...context,
      timeoutMs,
      pendingCount: this.pending.size,
    })
    if (!options.allowDuringShutdown) await this.start()
    if (!this.adapter || this.snapshot.status !== 'ready') {
      this.log('request_rejected_not_ready', {
        ...context,
        pendingCount: this.pending.size,
        status: this.snapshot.status,
      })
      throw new NativeRuntimeRequestError(
        nativeRuntimeError('runtime_lost', 'Native runtime is not ready', {
          retryable: true,
          ...context,
        }),
      )
    }
    if (this.pending.size >= NATIVE_RUNTIME_MAX_PENDING_REQUESTS) {
      this.log('request_rejected_queue_full', {
        ...context,
        pendingCount: this.pending.size,
      })
      throw new NativeRuntimeRequestError(
        nativeRuntimeError('queue_full', 'Native runtime command queue is full', {
          retryable: true,
          ...context,
        }),
      )
    }

    const requestId = `${this.options.runtime}-${++this.requestSequence}-${crypto.randomUUID()}`
    const request: NativeRuntimeRequest = { type: 'request', requestId, command }
    const startedAt = this.now()
    const adapterEpoch = this.adapterEpoch
    this.log('request_enqueued', {
      ...context,
      requestId,
      timeoutMs,
      pendingCount: this.pending.size + 1,
    })
    const result = new Promise<T>((resolve, reject) => {
      const timeout = setTimeout(() => {
        const timedOut = this.pending.get(requestId)
        if (!timedOut) return
        this.pending.delete(requestId)
        const timeoutMessage = `Native runtime request timed out (${context.stage})`
        this.releaseProbeKey(timedOut)
        this.log('request_timed_out', {
          ...context,
          requestId,
          timeoutMs,
          durationMs: this.now() - (timedOut?.startedAt ?? startedAt),
          pendingCount: this.pending.size,
        })
        const error = new NativeRuntimeRequestError(
          nativeRuntimeError('request_timeout', timeoutMessage, {
            retryable: true,
            ...context,
          }),
        )
        reject(error)
        if (hasUncertainMutationOutcome(command)) {
          this.recycleHungAdapterIfCurrent(
            timedOut.adapterEpoch,
            'request_outcome_unknown',
            timeoutMessage,
            'Native runtime recycled after a mutating command timed out with an uncertain outcome',
          )
          return
        }
        if (timedOut.kind === 'probe') {
          this.recycleHungAdapterIfCurrent(
            timedOut.adapterEpoch,
            'liveness_probe_failed',
            `Native runtime liveness probe timed out (${context.lane ?? 'unknown'})`,
            'Native runtime recycled after an actor liveness probe timed out',
          )
          return
        }
        if (options.probeOnTimeout === false || !context.lane) {
          return
        }
        this.ensureLaneProbe(
          timedOut.adapterEpoch,
          context.lane,
          timeoutMessage,
        )
      }, timeoutMs)
      this.pending.set(requestId, {
        resolve: (value) => resolve(value as T),
        reject,
        timeout,
        context,
        startedAt,
        kind: 'command',
        adapterEpoch,
      })
    })

    try {
      this.adapter.postMessage(request)
      this.log('request_posted', {
        ...context,
        requestId,
        timeoutMs,
        pendingCount: this.pending.size,
      })
    } catch (error) {
      const message =
        error instanceof Error
          ? redactSensitiveText(error.message)
          : 'Native runtime is unavailable'
      this.log('request_post_failed', {
        ...context,
        requestId,
        pendingCount: this.pending.size,
        message,
      })
      this.rejectPending(
        requestId,
        new NativeRuntimeRequestError(
          nativeRuntimeError('runtime_lost', message, {
            retryable: true,
            ...context,
          }),
        ),
      )
      // A failed structured-clone send means this transport can no longer be
      // trusted even if Electron has not delivered its exit event yet.
      this.recycleHungAdapterIfCurrent(
        adapterEpoch,
        'transport_error',
        message,
      )
    }
    return result
  }

  retry() {
    if (this.snapshot.status !== 'degraded') return this.start()
    this.crashTimes = []
    this.log('retry_requested', {
      restartCount: this.snapshot.restartCount,
      pendingCount: this.pending.size,
    })
    this.updateSnapshot({
      status: 'stopped',
      // Keep this epoch monotonic so controllers can distinguish a manual
      // circuit reset from the host instance that just degraded.
      restartCount: this.snapshot.restartCount + 1,
      degradedReason: undefined,
      lastFailure: undefined,
      failure: undefined,
    })
    return this.start()
  }

  shutdown() {
    if (this.shutdownPromise) return this.shutdownPromise
    let resolveShutdown!: () => void
    let rejectShutdown!: (error: unknown) => void
    const shutdown = new Promise<void>((resolve, reject) => {
      resolveShutdown = resolve
      rejectShutdown = reject
    })
    // Publish the sentinel before shutdownAtomic can synchronously notify an
    // observer. Reentrant shutdown calls must join this exact transition.
    this.shutdownPromise = shutdown
    void this.shutdownAtomic().then(
      () => {
        if (this.shutdownPromise === shutdown) this.shutdownPromise = null
        resolveShutdown()
      },
      (error) => {
        if (this.shutdownPromise === shutdown) this.shutdownPromise = null
        rejectShutdown(error)
      },
    )
    return shutdown
  }

  private async shutdownAtomic() {
    const shutdownEpoch = this.adapterEpoch
    this.expectedExitEpoch = shutdownEpoch
    this.log('shutdown_requested', {
      pendingCount: this.pending.size,
      status: this.snapshot.status,
    })
    this.clearRestartTimer()
    this.clearRetirementWatchdogs()
    const adapter = this.adapter
    if (adapter && this.snapshot.status === 'ready') {
      let stopListening = () => {}
      let timeout: ReturnType<typeof setTimeout> | null = null
      const exited = new Promise<void>((resolve) => {
        stopListening = this.onStateChange((snapshot) => {
          if (snapshot.status !== 'stopped') return
          stopListening()
          resolve()
        })
      })
      try {
        await Promise.race([
          Promise.all([
            this.request({ type: 'shutdown' }, 2_000, {
              probeOnTimeout: false,
              allowDuringShutdown: true,
            }).catch(() => undefined),
            exited,
          ]),
          new Promise<void>((resolve) => {
            timeout = setTimeout(resolve, 2_000)
          }),
        ])
      } finally {
        if (timeout) clearTimeout(timeout)
        stopListening()
      }
    }
    if (adapter && this.adapter === adapter) {
      adapter.kill()
      this.adapter = null
      this.log('adapter_killed', {
        reason: 'shutdown',
        pendingCount: this.pending.size,
      })
    }
    this.rejectAllPending('runtime_stopped', 'Native runtime stopped')
    this.clearHandshake()
    this.rejectStart?.(
      new NativeRuntimeRequestError(
        nativeRuntimeError('runtime_stopped', 'Native runtime stopped'),
      ),
    )
    this.clearStartPromise()
    this.updateSnapshot({
      status: 'stopped',
      pid: undefined,
      ready: undefined,
      degradedReason: undefined,
      failure: undefined,
    })
  }

  private handleMessage(
    adapter: NativeRuntimeAdapter,
    adapterEpoch: number,
    message: unknown,
  ) {
    if (!this.isCurrentHost(adapter, adapterEpoch) || !isNativeRuntimeMessage(message)) return
    if (message.type === 'ready') {
      if (
        message.runtime !== this.options.runtime ||
        message.contractVersion !== NATIVE_RUNTIME_CONTRACT_VERSION
      ) {
        const reason =
          message.runtime !== this.options.runtime
            ? `Native runtime kind mismatch (expected ${this.options.runtime}, received ${message.runtime})`
            : `Native runtime contract mismatch (expected ${NATIVE_RUNTIME_CONTRACT_VERSION}, received ${message.contractVersion})`
        this.degrade(failure('handshake_incompatible', reason, false), adapterEpoch)
        return
      }
      this.log('handshake_ready', {
        pendingCount: this.pending.size,
      })
      this.clearHandshake()
      this.updateSnapshot({
        status: 'ready',
        pid: adapter.pid,
        ready: message,
        degradedReason: undefined,
        failure: undefined,
      })
      this.resolveStart?.(message)
      this.clearStartPromise(adapterEpoch)
      return
    }
    if (message.type === 'reply') {
      const pending = this.pending.get(message.requestId)
      if (!pending) return
      this.pending.delete(message.requestId)
      clearTimeout(pending.timeout)
      this.releaseProbeKey(pending)
      if (message.ok) {
        this.log(pending.kind === 'probe' ? 'probe_reply_ok' : 'request_reply_ok', {
          ...pending.context,
          requestId: message.requestId,
          durationMs: this.now() - pending.startedAt,
          pendingCount: this.pending.size,
        })
        pending.resolve(message.result)
        if (
          pending.kind === 'probe' &&
          pending.context.lane &&
          isBusyProbeResult(message.result)
        ) {
          this.armRetirementWatchdog(
            pending.context.lane,
            pending.adapterEpoch,
          )
        }
        if (
          pending.kind === 'command' &&
          pending.context.lane &&
          shouldWatchRetirementAfter(pending.context.stage)
        ) {
          this.armRetirementWatchdog(
            pending.context.lane,
            pending.adapterEpoch,
          )
        }
      } else {
        this.log(pending.kind === 'probe' ? 'probe_reply_error' : 'request_reply_error', {
          ...pending.context,
          requestId: message.requestId,
          durationMs: this.now() - pending.startedAt,
          pendingCount: this.pending.size,
          errorCode: message.error.code,
          message: message.error.message,
        })
        const error = new NativeRuntimeRequestError(message.error)
        pending.reject(error)
        if (pending.kind === 'probe') {
          this.recycleHungAdapterIfCurrent(
            pending.adapterEpoch,
            'liveness_probe_failed',
            `Native runtime liveness probe failed (${pending.context.lane ?? 'unknown'})`,
            'Native runtime recycled after an actor liveness probe failed',
          )
        } else if (message.error.code === 'actor_unresponsive') {
          this.recycleHungAdapterIfCurrent(
            pending.adapterEpoch,
            'actor_unresponsive',
            `Native runtime actor reported lost capacity (${pending.context.lane ?? 'unknown'})`,
            'Native runtime recycled after an actor became unresponsive',
          )
        }
      }
      return
    }
    const event = message.event
    const isLossyMedia = isLossyMediaEvent(event)
    if (!isLossyMedia && event.sequence <= this.lastControlEventSequence) {
      this.log('runtime_event_dropped_out_of_order', {
        nativeEventType: event.type,
        nativeSequence: event.sequence,
        pendingCount: this.pending.size,
        message: `last=${this.lastControlEventSequence}`,
      })
      return
    }
    if (!isLossyMedia) {
      this.lastControlEventSequence = event.sequence
      this.log('runtime_event_received', {
        nativeEventType: event.type,
        nativeSequence: event.sequence,
        requestId: 'requestId' in event ? event.requestId : undefined,
        sessionId: 'sessionId' in event ? event.sessionId : undefined,
        generation: 'generation' in event ? event.generation : undefined,
        status: event.type === 'sessionLifecycle' ? event.state.status : undefined,
        stage: event.type === 'runtimeError' ? event.error.stage : undefined,
        errorCode: event.type === 'runtimeError' ? event.error.code : undefined,
        message: event.type === 'runtimeError' ? event.error.message : undefined,
        pendingCount: this.pending.size,
      })
    }
    for (const listener of this.eventListeners) {
      try {
        listener(event)
      } catch {
        // A consumer failure must not corrupt request correlation or later consumers.
      }
    }
  }

  private handleExit(
    adapter: NativeRuntimeAdapter,
    adapterEpoch: number,
    exit: NativeRuntimeAdapterExit,
  ) {
    if (!this.isCurrentHost(adapter, adapterEpoch)) return
    this.adapter = null
    this.clearHandshake()
    this.clearRetirementWatchdogs()
    const message = exit.error
      ? redactSensitiveText(exit.error.message)
      : `Native runtime exited (${exit.code ?? 'unknown'})`
    this.log('adapter_exited', {
      pendingCount: this.pending.size,
      message,
      reason: this.expectedExitEpoch === adapterEpoch ? 'expected' : 'unexpected',
    })
    this.rejectStart?.(
      new NativeRuntimeRequestError(
        nativeRuntimeError('runtime_lost', message, { retryable: true }),
      ),
    )
    this.clearStartPromise(adapterEpoch)
    this.rejectAllPending('runtime_lost', message)
    if (this.expectedExitEpoch === adapterEpoch) {
      this.updateSnapshot({ status: 'stopped', pid: undefined, ready: undefined })
      return
    }
    this.scheduleRestart(failure(
      exit.error ? 'transport_error' : 'process_exit',
      message,
    ), adapterEpoch)
  }

  private scheduleRestart(runtimeFailure: NativeRuntimeFailure, hostEpoch = this.adapterEpoch) {
    const now = (this.options.now ?? Date.now)()
    this.crashTimes = this.crashTimes.filter((time) => now - time <= CRASH_WINDOW_MS)
    this.crashTimes.push(now)
    if (this.crashTimes.length >= 3) {
      this.log('restart_aborted_circuit_open', {
        pendingCount: this.pending.size,
        message: redactSensitiveText(runtimeFailure.message),
      })
      this.degrade(
        failure('circuit_open', runtimeFailure.message, false),
        hostEpoch,
      )
      return
    }
    const restartCount = this.snapshot.restartCount + 1
    this.updateSnapshot({
      status: 'recovering',
      pid: undefined,
      ready: undefined,
      restartCount,
      lastFailure: redactSensitiveText(runtimeFailure.message),
      failure: sanitizeFailure(runtimeFailure),
    })
    if (this.expectedExitEpoch === hostEpoch || this.shutdownPromise) return
    const crashIndex = Math.min(
      this.crashTimes.length - 1,
      RESTART_DELAYS_MS.length - 1,
    )
    const delay = RESTART_DELAYS_MS[crashIndex]
    this.log('restart_scheduled', {
      pendingCount: this.pending.size,
      restartCount,
      delayMs: delay,
      message: redactSensitiveText(runtimeFailure.message),
    })
    const schedule = this.options.schedule ?? setTimeout
    const scheduleEpoch = ++this.restartScheduleEpoch
    this.restartTimer = schedule(() => {
      if (scheduleEpoch !== this.restartScheduleEpoch || this.shutdownPromise) return
      this.restartTimer = null
      void this.start().catch(() => {})
    }, delay)
  }

  private failHandshake(
    adapter: NativeRuntimeAdapter,
    adapterEpoch: number,
    runtimeFailure: NativeRuntimeFailure,
  ) {
    if (!this.isCurrentHost(adapter, adapterEpoch)) return
    this.adapter = null
    adapter.kill()
    this.log('handshake_failed', {
      pendingCount: this.pending.size,
      message: redactSensitiveText(runtimeFailure.message),
    })
    this.clearHandshake()
    this.clearRetirementWatchdogs()
    const error = new NativeRuntimeRequestError(
      nativeRuntimeError('handshake_failed', redactSensitiveText(runtimeFailure.message), {
        retryable: runtimeFailure.retryable,
      }),
    )
    this.rejectStart?.(error)
    this.clearStartPromise(adapterEpoch)
    this.scheduleRestart(runtimeFailure, adapterEpoch)
  }

  private degrade(runtimeFailure: NativeRuntimeFailure, hostEpoch = this.adapterEpoch) {
    if (hostEpoch !== this.adapterEpoch) return
    this.expectedExitEpoch = hostEpoch
    this.adapter?.kill()
    this.adapter = null
    this.log('runtime_degraded', {
      pendingCount: this.pending.size,
      message: redactSensitiveText(runtimeFailure.message),
    })
    this.clearHandshake()
    this.clearRestartTimer()
    this.clearRetirementWatchdogs()
    this.rejectStart?.(
      new NativeRuntimeRequestError(
        nativeRuntimeError(
          'runtime_degraded',
          redactSensitiveText(runtimeFailure.message),
          { retryable: runtimeFailure.retryable },
        ),
      ),
    )
    this.clearStartPromise(hostEpoch)
    this.rejectAllPending('runtime_degraded', runtimeFailure.message)
    this.updateSnapshot({
      status: 'degraded',
      pid: undefined,
      ready: undefined,
      degradedReason: redactSensitiveText(runtimeFailure.message),
      failure: sanitizeFailure(runtimeFailure),
    })
  }

  private rejectPending(requestId: string, error: Error) {
    const pending = this.pending.get(requestId)
    if (!pending) return
    this.pending.delete(requestId)
    clearTimeout(pending.timeout)
    this.releaseProbeKey(pending)
    this.log('request_rejected', {
      ...pending.context,
      requestId,
      durationMs: this.now() - pending.startedAt,
      pendingCount: this.pending.size,
      message: error.message,
      errorCode:
        error instanceof NativeRuntimeRequestError ? error.detail.code : undefined,
    })
    pending.reject(error)
  }

  private recycleHungAdapterIfCurrent(
    adapterEpoch: number,
    cause: NativeRuntimeFailureCause,
    reason: string,
    pendingMessage = reason,
  ) {
    if (this.adapterEpoch !== adapterEpoch) return
    this.recycleHungAdapter(
      failure(cause, reason),
      pendingMessage,
    )
  }

  private recycleHungAdapter(
    runtimeFailure: NativeRuntimeFailure,
    pendingMessage = runtimeFailure.message,
  ) {
    const adapter = this.adapter
    if (!adapter) return
    this.adapter = null
    this.clearRetirementWatchdogs()
    adapter.kill()
    this.log('adapter_recycled', {
      pendingCount: this.pending.size,
      message: redactSensitiveText(runtimeFailure.message),
      reason: redactSensitiveText(pendingMessage),
    })
    this.rejectAllPending('runtime_lost', pendingMessage)
    if (this.expectedExitEpoch === this.adapterEpoch) {
      this.updateSnapshot({
        status: 'stopped',
        pid: undefined,
        ready: undefined,
      })
      return
    }
    this.scheduleRestart(runtimeFailure)
  }

  private rejectAllPending(code: string, message: string) {
    const safeMessage = redactSensitiveText(message)
    for (const [requestId, pending] of Array.from(this.pending.entries())) {
      this.rejectPending(
        requestId,
        new NativeRuntimeRequestError(
          nativeRuntimeError(code, safeMessage, {
            retryable: true,
            ...pending.context,
          }),
        ),
      )
    }
  }

  private clearHandshake() {
    if (!this.handshakeTimer) return
    clearTimeout(this.handshakeTimer)
    this.handshakeTimer = null
  }

  private clearRestartTimer() {
    this.restartScheduleEpoch += 1
    if (!this.restartTimer) return
    clearTimeout(this.restartTimer)
    this.restartTimer = null
  }

  private armRetirementWatchdog(
    lane: NativeRuntimeLane,
    adapterEpoch: number,
  ) {
    if (lane !== 'microphone' && lane !== 'screen' && lane !== 'camera') return
    const existing = this.retirementWatchdogs.get(lane)
    if (existing) clearTimeout(existing)
    const timer = setTimeout(() => {
      this.retirementWatchdogs.delete(lane)
      void this.runRetirementWatchdog(lane, adapterEpoch)
    }, RETIREMENT_WATCHDOG_INTERVAL_MS)
    this.retirementWatchdogs.set(lane, timer)
  }

  private async runRetirementWatchdog(
    lane: NativeRuntimeLane,
    adapterEpoch: number,
  ) {
    if (
      !this.adapter ||
      this.adapterEpoch !== adapterEpoch ||
      this.snapshot.status !== 'ready'
    ) {
      return
    }
    if (this.hasPendingLaneCommand(lane, adapterEpoch)) {
      this.armRetirementWatchdog(lane, adapterEpoch)
      return
    }
    const command = probeCommand(this.options.runtime, lane)
    if (!command) return
    try {
      const result = await this.request<Record<string, unknown>>(
        command,
        this.options.probeTimeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS,
        { probeOnTimeout: false },
      )
      if (result?.state === 'busy') {
        this.armRetirementWatchdog(lane, adapterEpoch)
      }
    } catch (error) {
      this.recycleHungAdapterIfCurrent(
        adapterEpoch,
        'liveness_probe_failed',
        error instanceof Error
          ? error.message
          : `Native runtime retirement watchdog failed (${lane})`,
        'Native runtime recycled after a retirement watchdog failed',
      )
    }
  }

  private clearRetirementWatchdogs() {
    for (const timer of this.retirementWatchdogs.values()) clearTimeout(timer)
    this.retirementWatchdogs.clear()
  }

  private clearStartPromise(epoch?: number) {
    if (epoch !== undefined && this.startEpoch !== epoch) return
    this.startPromise = null
    this.resolveStart = null
    this.rejectStart = null
    this.startEpoch = null
  }

  private waitForScheduledStart() {
    return new Promise<NativeRuntimeReady>((resolve, reject) => {
      const stopListening = this.onStateChange((snapshot) => {
        if (snapshot.status === 'ready' && snapshot.ready) {
          stopListening()
          resolve(snapshot.ready)
          return
        }
        if (snapshot.status !== 'degraded' && snapshot.status !== 'stopped') return
        stopListening()
        const code = snapshot.status === 'degraded'
          ? 'runtime_degraded'
          : 'runtime_stopped'
        reject(
          new NativeRuntimeRequestError(
            nativeRuntimeError(
              code,
              snapshot.degradedReason ?? 'Native runtime stopped before recovery',
              { retryable: snapshot.status !== 'degraded' },
            ),
          ),
        )
      })
    })
  }

  private ensureLaneProbe(
    adapterEpoch: number,
    lane: NativeRuntimeLane,
    timeoutMessage: string,
  ) {
    if (!this.adapter || this.adapterEpoch !== adapterEpoch) return
    const probeKey = `${adapterEpoch}:${lane}`
    if (this.activeProbeKeys.has(probeKey)) {
      this.log('probe_coalesced', {
        pendingCount: this.pending.size,
        message: `${lane}:${timeoutMessage}`,
      })
      return
    }
    const command = probeCommand(this.options.runtime, lane)
    if (!command) return
    const requestId = `${this.options.runtime}-probe-${++this.requestSequence}-${crypto.randomUUID()}`
    const request: NativeRuntimeRequest = { type: 'request', requestId, command }
    const startedAt = this.now()
    const context: NativeRuntimeRequestContext = {
      stage: command.type,
      lane,
    }
    const timeoutMs = this.options.probeTimeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS
    const timeout = setTimeout(() => {
      const pending = this.pending.get(requestId)
      if (!pending) return
      this.pending.delete(requestId)
      this.releaseProbeKey(pending)
      this.log('probe_timed_out', {
        ...context,
        requestId,
        timeoutMs,
        durationMs: this.now() - startedAt,
        pendingCount: this.pending.size,
      })
      pending.reject(
        new NativeRuntimeRequestError(
          nativeRuntimeError(
            'request_timeout',
            `Native runtime liveness probe timed out (${lane})`,
            {
              retryable: true,
              stage: command.type,
            },
          ),
        ),
      )
      this.recycleHungAdapterIfCurrent(
        adapterEpoch,
        'liveness_probe_failed',
        `Native runtime liveness probe timed out (${lane})`,
        'Native runtime recycled after an actor liveness probe timed out',
      )
    }, timeoutMs)
    this.activeProbeKeys.add(probeKey)
    this.pending.set(requestId, {
      resolve: () => undefined,
      reject: () => undefined,
      timeout,
      context,
      startedAt,
      kind: 'probe',
      probeKey,
      adapterEpoch,
    })
    try {
      this.adapter.postMessage(request)
      this.log('probe_enqueued', {
        ...context,
        requestId,
        timeoutMs,
        pendingCount: this.pending.size,
        message: timeoutMessage,
      })
    } catch (error) {
      const message =
        error instanceof Error
          ? redactSensitiveText(error.message)
          : 'Native runtime is unavailable'
      this.rejectPending(
        requestId,
        new NativeRuntimeRequestError(
          nativeRuntimeError('runtime_lost', message, {
            retryable: true,
            stage: command.type,
          }),
        ),
      )
      this.recycleHungAdapterIfCurrent(adapterEpoch, 'transport_error', message)
    }
  }

  private releaseProbeKey(pending: PendingRequest) {
    if (!pending.probeKey) return
    this.activeProbeKeys.delete(pending.probeKey)
  }

  private updateSnapshot(patch: Partial<NativeRuntimeSupervisorSnapshot>) {
    this.snapshot = { ...this.snapshot, ...patch }
    this.log('state_changed', {
      pendingCount: this.pending.size,
      status: this.snapshot.status,
      restartCount: this.snapshot.restartCount,
      message: this.snapshot.lastFailure ?? this.snapshot.degradedReason,
    })
    const snapshot = this.getSnapshot()
    for (const listener of this.stateListeners) {
      try {
        listener(snapshot)
      } catch {
        // Supervisor lifecycle must remain independent from observer failures.
      }
    }
  }

  private hasPendingLaneCommand(
    lane: NativeRuntimeLane,
    adapterEpoch: number,
  ) {
    for (const pending of this.pending.values()) {
      if (
        pending.kind === 'command' &&
        pending.adapterEpoch === adapterEpoch &&
        pending.context.lane === lane
      ) {
        return true
      }
    }
    return false
  }

  private isCurrentHost(adapter: NativeRuntimeAdapter, epoch: number) {
    return this.adapter === adapter && this.adapterEpoch === epoch
  }

  private failStartWithoutHost(runtimeFailure: NativeRuntimeFailure) {
    const error = new NativeRuntimeRequestError(
      nativeRuntimeError(
        'handshake_failed',
        redactSensitiveText(runtimeFailure.message),
        { retryable: runtimeFailure.retryable },
      ),
    )
    this.rejectStart?.(error)
    this.clearStartPromise()
    this.scheduleRestart(runtimeFailure)
  }

  private now() {
    return (this.options.now ?? Date.now)()
  }

  private log(
    event: string,
    detail: Omit<
      Parameters<NonNullable<NativeRuntimeSupervisorOptions['diagnostics']>>[0],
      'scope' | 'event' | 'runtime'
    >,
  ) {
    this.options.diagnostics?.({
      scope: 'native-runtime-supervisor',
      event,
      runtime: this.options.runtime,
      ...detail,
    })
  }
}

function failure(
  cause: NativeRuntimeFailureCause,
  message: string,
  retryable = true,
): NativeRuntimeFailure {
  return { cause, message: redactSensitiveText(message), retryable }
}

function assertSafeSequence(value: number, label: string) {
  if (!Number.isSafeInteger(value)) {
    throw new Error(`Native runtime ${label} exhausted`)
  }
}

function sanitizeFailure(value: NativeRuntimeFailure): NativeRuntimeFailure {
  return { ...value, message: redactSensitiveText(value.message) }
}

function isLossyMediaEvent(event: NativeRuntimeEvent) {
  return (
    event.type === 'microphoneMetrics' ||
    event.type === 'stats' ||
    event.type === 'remoteVideoFrame' ||
    event.type === 'localScreenPreviewFrame' ||
    event.type === 'localCameraPreviewFrame'
  )
}

function requestLane(command: NativeRuntimeCommand): NativeRuntimeLane | undefined {
  switch (command.type) {
    case 'connectVoice':
    case 'disconnectVoice':
    case 'configureRemoteAudio':
    case 'configureVoiceOutput':
      return 'voice'
    case 'warmMicrophone':
    case 'startPreview':
    case 'stopPreview':
    case 'connectMicrophone':
    case 'disconnectMicrophone':
    case 'invalidateMicrophone':
    case 'configureMicrophone':
    case 'setMicrophoneMuted':
    case 'probeMicrophoneActor':
      return 'microphone'
    case 'connectScreen':
    case 'startScreenCapture':
    case 'stopScreenCapture':
    case 'disconnectScreen':
    case 'probeScreenActor':
      return 'screen'
    case 'connectCamera':
    case 'disconnectCamera':
    case 'probeCameraActor':
      return 'camera'
    case 'listDevices':
    case 'listDisplaySources':
    case 'probeQueryWorker':
      return 'query'
    case 'startHotkeys':
    case 'stopHotkeys':
    case 'startOverlay':
    case 'stopOverlay':
    case 'probeHooksRuntime':
      return command.type === 'startHotkeys' || command.type === 'stopHotkeys' ? 'hotkey' : 'overlay'
    case 'shutdown':
      return undefined
  }
}

function hasUncertainMutationOutcome(command: NativeRuntimeCommand) {
  switch (command.type) {
    case 'connectVoice':
    case 'disconnectVoice':
      return true
    default:
      return false
  }
}

function shouldWatchRetirementAfter(
  stage: NativeRuntimeCommand['type'],
) {
  return (
    stage === 'connectMicrophone' ||
    stage === 'disconnectMicrophone' ||
    stage === 'connectScreen' ||
    stage === 'startScreenCapture' ||
    stage === 'stopScreenCapture' ||
    stage === 'disconnectScreen' ||
    stage === 'connectCamera' ||
    stage === 'disconnectCamera'
  )
}

function probeCommand(
  runtime: NativeRuntimeKind,
  lane: NativeRuntimeLane,
): NativeRuntimeCommand | null {
  if (runtime === 'media') {
    if (lane === 'microphone') return { type: 'probeMicrophoneActor' }
    if (lane === 'screen') return { type: 'probeScreenActor' }
    if (lane === 'camera') return { type: 'probeCameraActor' }
    if (lane === 'query') return { type: 'probeQueryWorker' }
    return null
  }
  if (lane === 'hotkey' || lane === 'overlay') {
    return { type: 'probeHooksRuntime' }
  }
  return null
}

function isBusyProbeResult(value: unknown) {
  return Boolean(
    value && typeof value === 'object' &&
    'state' in value && value.state === 'busy',
  )
}
