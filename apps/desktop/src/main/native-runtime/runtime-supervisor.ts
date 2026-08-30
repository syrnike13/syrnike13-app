import { Effect } from 'effect'

import {
  NATIVE_RUNTIME_CONTRACT_VERSION,
  NATIVE_RUNTIME_MAX_PENDING_REQUESTS,
  isNativeRuntimeMessage,
  nativeRuntimeCommandLane,
  nativeRuntimeError,
  redactSensitiveText,
  type NativeRuntimeCommand,
  type NativeRuntimeError,
  type NativeRuntimeEvent,
  type NativeRuntimeKind,
  type NativeRuntimeReady,
  type NativeRuntimeReply,
  type NativeRuntimeRequest,
} from './contract'
import type {
  NativeRuntimeAdapter,
  NativeRuntimeAdapterExit,
  NativeRuntimeAdapterFactory,
} from './utility-adapter'

export type NativeRuntimeSupervisorStatus =
  | 'stopped'
  | 'starting'
  | 'ready'
  | 'recovering'
  | 'degraded'

export type NativeRuntimeFailureCause =
  | 'start'
  | 'handshake'
  | 'protocol'
  | 'exit'
  | 'request_timeout'

export type NativeRuntimeFailure = {
  cause: NativeRuntimeFailureCause
  message: string
  retryable: boolean
}

export type NativeRuntimeSupervisorSnapshot = {
  runtime: NativeRuntimeKind
  status: NativeRuntimeSupervisorStatus
  restartCount: number
  pid?: number
  failure?: NativeRuntimeFailure
  nextRetryAt?: number
  ready?: NativeRuntimeReady
}

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
}

export type NativeRuntimeSupervisorOptions = {
  runtime: NativeRuntimeKind
  createAdapter: NativeRuntimeAdapterFactory
  handshakeTimeoutMs?: number
  restartDelaysMs?: readonly number[]
  requestId?: () => string
  now?: () => number
}

export class NativeRuntimeSupervisor {
  private adapter: NativeRuntimeAdapter | null = null
  private adapterEpoch = 0
  private snapshot: NativeRuntimeSupervisorSnapshot
  private readonly eventListeners = new Set<(event: NativeRuntimeEvent) => void>()
  private readonly stateListeners = new Set<
    (snapshot: NativeRuntimeSupervisorSnapshot) => void
  >()
  private readonly pending = new Map<string, PendingRequest>()
  private startPromise: Promise<NativeRuntimeReady> | null = null
  private resolveStart: ((ready: NativeRuntimeReady) => void) | null = null
  private rejectStart: ((error: Error) => void) | null = null
  private handshakeTimer: ReturnType<typeof setTimeout> | null = null
  private restartTimer: ReturnType<typeof setTimeout> | null = null
  private restartAttempt = 0
  private requestSequence = 0
  private hasStarted = false
  private shuttingDown = false

  constructor(private readonly options: NativeRuntimeSupervisorOptions) {
    this.snapshot = {
      runtime: options.runtime,
      status: 'stopped',
      restartCount: 0,
    }
  }

  getSnapshot() {
    return this.snapshot
  }

  getPendingRequestCount() {
    return this.pending.size
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
    if (this.snapshot.status === 'ready' && this.snapshot.ready) {
      return Promise.resolve(this.snapshot.ready)
    }
    if (this.startPromise) return this.startPromise
    if (this.shuttingDown) {
      return Promise.reject(
        new NativeRuntimeRequestError(
          nativeRuntimeError(
            'runtime_stopping',
            'Native hooks runtime is shutting down',
          ),
        ),
      )
    }

    this.clearRestartTimer()
    const recovering = this.hasStarted
    this.updateSnapshot({
      status: recovering ? 'recovering' : 'starting',
      failure: undefined,
      nextRetryAt: undefined,
      ready: undefined,
    })

    const startPromise = new Promise<NativeRuntimeReady>((resolve, reject) => {
      this.resolveStart = resolve
      this.rejectStart = reject
    })
    this.startPromise = startPromise
    const adapter = this.options.createAdapter()
    const epoch = ++this.adapterEpoch
    this.adapter = adapter
    try {
      adapter.start({
        onMessage: (message) => this.handleMessage(adapter, epoch, message),
        onExit: (exit) => this.handleExit(adapter, epoch, exit),
      })
      this.updateSnapshot({ pid: adapter.pid })
    } catch (error) {
      const failure = makeFailure('start', error, true)
      this.failStart(failure)
      this.adapter = null
      this.scheduleRestart(failure)
    }

    if (this.adapter === adapter) {
      this.handshakeTimer = setTimeout(
        () => this.failHandshake(adapter, epoch),
        this.options.handshakeTimeoutMs ?? 5_000,
      )
      this.handshakeTimer.unref?.()
    }
    return startPromise
  }

  startEffect() {
    return Effect.tryPromise({
      try: () => this.start(),
      catch: (cause) =>
        cause instanceof Error ? cause : new Error(String(cause)),
    })
  }

  request(command: NativeRuntimeCommand, timeoutMs = 5_000) {
    return Effect.runPromise(this.requestEffect(command, timeoutMs))
  }

  requestEffect(command: NativeRuntimeCommand, timeoutMs = 5_000) {
    return this.startEffect().pipe(
      Effect.flatMap(() =>
        Effect.tryPromise({
          try: () => this.sendRequest(command, timeoutMs),
          catch: (cause) =>
            cause instanceof Error ? cause : new Error(String(cause)),
        }),
      ),
    )
  }

  retry() {
    return Effect.runPromise(this.retryEffect())
  }

  retryEffect() {
    return Effect.suspend(() => {
      if (this.snapshot.status !== 'degraded') return Effect.void
      this.restartAttempt = 0
      return this.startEffect().pipe(Effect.asVoid)
    })
  }

  shutdown() {
    return Effect.runPromise(this.shutdownEffect())
  }

  shutdownEffect() {
    return Effect.suspend(() => {
      if (this.shuttingDown) return Effect.void
      this.shuttingDown = true
      this.clearRestartTimer()
      const adapter = this.adapter
      if (!adapter) {
        this.finishStopped()
        return Effect.void
      }
      const graceful =
        this.snapshot.status === 'ready'
          ? Effect.tryPromise({
              try: () => this.sendRequest({ type: 'shutdown' }, 1_000),
              catch: () => undefined,
            }).pipe(Effect.ignore)
          : Effect.void
      return graceful.pipe(
        Effect.ensuring(
          Effect.sync(() => {
            if (this.adapter === adapter) adapter.kill()
            this.adapter = null
            this.finishStopped()
          }),
        ),
        Effect.asVoid,
      )
    })
  }

  private sendRequest(command: NativeRuntimeCommand, timeoutMs: number) {
    const adapter = this.adapter
    if (!adapter || this.snapshot.status !== 'ready') {
      return Promise.reject(
        new NativeRuntimeRequestError(
          nativeRuntimeError(
            'runtime_unavailable',
            'Native hooks runtime is not ready',
            { retryable: true },
          ),
        ),
      )
    }
    if (this.pending.size >= NATIVE_RUNTIME_MAX_PENDING_REQUESTS) {
      return Promise.reject(
        new NativeRuntimeRequestError(
          nativeRuntimeError(
            'request_capacity_exceeded',
            'Native hooks request capacity is exhausted',
            { retryable: true },
          ),
        ),
      )
    }

    const lane = nativeRuntimeCommandLane(command)
    if (
      lane !== 'runtime' &&
      lane !== this.options.runtime &&
      command.type !== 'probeHooksRuntime'
    ) {
      return Promise.reject(
        new NativeRuntimeRequestError(
          nativeRuntimeError(
            'invalid_runtime_command',
            `Command ${command.type} does not belong to ${this.options.runtime}`,
          ),
        ),
      )
    }

    const requestId = this.nextRequestId()
    const request: NativeRuntimeRequest = {
      type: 'request',
      requestId,
      lane: command.type === 'probeHooksRuntime' ? this.options.runtime : lane,
      hostEpoch: this.adapterEpoch,
      command,
    }
    return new Promise<unknown>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(requestId)
        const error = new NativeRuntimeRequestError(
          nativeRuntimeError(
            'request_timeout',
            `Native hooks request timed out: ${command.type}`,
            { retryable: true, stage: command.type },
          ),
        )
        reject(error)
        this.retireAdapter(
          makeFailure('request_timeout', error, true),
          adapter,
        )
      }, Math.max(1, timeoutMs))
      timeout.unref?.()
      this.pending.set(requestId, { resolve, reject, timeout })
      try {
        adapter.postMessage(request)
      } catch (error) {
        clearTimeout(timeout)
        this.pending.delete(requestId)
        reject(error instanceof Error ? error : new Error(String(error)))
        this.retireAdapter(makeFailure('exit', error, true), adapter)
      }
    })
  }

  private handleMessage(
    adapter: NativeRuntimeAdapter,
    epoch: number,
    message: unknown,
  ) {
    if (adapter !== this.adapter || epoch !== this.adapterEpoch) return
    if (!isNativeRuntimeMessage(message)) {
      this.retireAdapter(
        makeFailure('protocol', 'Native hooks runtime sent an invalid message', false),
        adapter,
      )
      return
    }
    if (message.type === 'ready') {
      if (
        message.contractVersion !== NATIVE_RUNTIME_CONTRACT_VERSION ||
        message.runtime !== this.options.runtime
      ) {
        this.retireAdapter(
          makeFailure(
            'handshake',
            `Native hooks runtime handshake mismatch for ${this.options.runtime}`,
            false,
          ),
          adapter,
        )
        return
      }
      this.clearHandshake()
      this.restartAttempt = 0
      const restartCount = this.hasStarted
        ? this.snapshot.restartCount + 1
        : this.snapshot.restartCount
      this.hasStarted = true
      this.updateSnapshot({
        status: 'ready',
        restartCount,
        pid: adapter.pid,
        failure: undefined,
        nextRetryAt: undefined,
        ready: message,
      })
      this.resolveStart?.(message)
      this.clearStartPromise()
      return
    }
    if (message.type === 'event') {
      for (const listener of this.eventListeners) listener(message.event)
      return
    }
    this.settleReply(message)
  }

  private settleReply(reply: NativeRuntimeReply) {
    const pending = this.pending.get(reply.requestId)
    if (!pending) return
    this.pending.delete(reply.requestId)
    clearTimeout(pending.timeout)
    if (reply.ok) pending.resolve(reply.result)
    else pending.reject(new NativeRuntimeRequestError(reply.error))
  }

  private handleExit(
    adapter: NativeRuntimeAdapter,
    epoch: number,
    exit: NativeRuntimeAdapterExit,
  ) {
    if (adapter !== this.adapter || epoch !== this.adapterEpoch) return
    this.adapter = null
    this.clearHandshake()
    const failure = makeFailure(
      'exit',
      exit.error ?? `Native hooks runtime exited with code ${String(exit.code)}`,
      !this.shuttingDown,
    )
    this.failStart(failure)
    this.rejectAllPending('runtime_lost', failure.message)
    if (this.shuttingDown) {
      this.finishStopped()
      return
    }
    this.scheduleRestart(failure)
  }

  private failHandshake(adapter: NativeRuntimeAdapter, epoch: number) {
    if (adapter !== this.adapter || epoch !== this.adapterEpoch) return
    this.retireAdapter(
      makeFailure('handshake', 'Native hooks runtime handshake timed out', true),
      adapter,
    )
  }

  private retireAdapter(
    failure: NativeRuntimeFailure,
    adapter: NativeRuntimeAdapter,
  ) {
    if (adapter !== this.adapter) return
    this.adapter = null
    this.adapterEpoch += 1
    this.clearHandshake()
    try {
      adapter.kill()
    } catch {
      // Retirement is already committed; recovery does not depend on kill.
    }
    this.failStart(failure)
    this.rejectAllPending('runtime_lost', failure.message)
    if (this.shuttingDown) this.finishStopped()
    else if (failure.retryable) this.scheduleRestart(failure)
    else this.degrade(failure)
  }

  private scheduleRestart(failure: NativeRuntimeFailure) {
    const delays = this.options.restartDelaysMs ?? [250, 1_000, 3_000]
    const delay = delays[this.restartAttempt]
    if (delay === undefined) {
      this.degrade(failure)
      return
    }
    this.restartAttempt += 1
    this.updateSnapshot({
      status: 'recovering',
      pid: undefined,
      failure,
      nextRetryAt: this.now() + delay,
      ready: undefined,
    })
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null
      void this.start().catch(() => {})
    }, delay)
    this.restartTimer.unref?.()
  }

  private degrade(failure: NativeRuntimeFailure) {
    this.updateSnapshot({
      status: 'degraded',
      pid: undefined,
      failure,
      nextRetryAt: undefined,
      ready: undefined,
    })
  }

  private failStart(failure: NativeRuntimeFailure) {
    this.rejectStart?.(
      new NativeRuntimeRequestError(
        nativeRuntimeError(
          failure.cause === 'handshake'
            ? 'handshake_failed'
            : 'runtime_lost',
          failure.message,
          { retryable: failure.retryable },
        ),
      ),
    )
    this.clearStartPromise()
  }

  private rejectAllPending(code: string, message: string) {
    const error = new NativeRuntimeRequestError(
      nativeRuntimeError(code, message, { retryable: true }),
    )
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timeout)
      pending.reject(error)
    }
    this.pending.clear()
  }

  private finishStopped() {
    this.clearHandshake()
    this.clearStartPromise()
    this.rejectAllPending('runtime_stopped', 'Native hooks runtime stopped')
    this.updateSnapshot({
      status: 'stopped',
      pid: undefined,
      failure: undefined,
      nextRetryAt: undefined,
      ready: undefined,
    })
  }

  private clearHandshake() {
    if (!this.handshakeTimer) return
    clearTimeout(this.handshakeTimer)
    this.handshakeTimer = null
  }

  private clearRestartTimer() {
    if (!this.restartTimer) return
    clearTimeout(this.restartTimer)
    this.restartTimer = null
  }

  private clearStartPromise() {
    this.startPromise = null
    this.resolveStart = null
    this.rejectStart = null
  }

  private updateSnapshot(patch: Partial<NativeRuntimeSupervisorSnapshot>) {
    this.snapshot = { ...this.snapshot, ...patch }
    for (const listener of this.stateListeners) listener(this.snapshot)
  }

  private nextRequestId() {
    this.requestSequence += 1
    return this.options.requestId?.() ??
      `${this.options.runtime}-${this.adapterEpoch}-${this.requestSequence}`
  }

  private now() {
    return this.options.now?.() ?? Date.now()
  }
}

function makeFailure(
  cause: NativeRuntimeFailureCause,
  error: unknown,
  retryable: boolean,
): NativeRuntimeFailure {
  const message = error instanceof Error ? error.message : String(error)
  return { cause, message: redactSensitiveText(message), retryable }
}
