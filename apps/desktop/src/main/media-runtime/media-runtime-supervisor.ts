import { Effect, Option, Schema } from 'effect'

import {
  MEDIA_LIFECYCLE_HANDSHAKE_TIMEOUT_MS,
  MEDIA_LIFECYCLE_MAX_PENDING_REQUESTS,
  MEDIA_LIFECYCLE_OUTER_SHUTDOWN_MS,
  MEDIA_LIFECYCLE_PING_TIMEOUT_MS,
  MEDIA_LIFECYCLE_PROTOCOL_VERSION,
  MEDIA_LIFECYCLE_SHUTDOWN_TIMEOUT_MS,
  MediaAddonPingSchema,
  MediaAddonSnapshotSchema,
  MediaCredentialLeaseInstalledSchema,
  MediaDesiredStateAcceptedSchema,
  MediaLifecycleHandshakeResultSchema,
  MediaLifecycleError,
  isMediaLifecycleMessage,
  mediaLifecycleError,
  mediaLifecycleFailure,
  type MediaLifecycleCommand,
  type MediaCredentialLease,
  type EngineDesiredState,
  type MediaLifecycleResult,
  type MediaLifecycleDiagnosticEvent,
  type MediaLifecycleEvent,
  type MediaEngineSnapshot,
  type MediaLifecycleFailure,
  type MediaLifecycleReady,
  type MediaLifecycleReply,
  type MediaLifecycleRequest,
} from './contract'
import type {
  MediaUtilityAdapter,
  MediaUtilityAdapterFactory,
  MediaUtilityExit,
} from './media-utility-adapter'

export type MediaRuntimeSupervisorStatus =
  | 'stopped'
  | 'starting'
  | 'ready'
  | 'recovering'
  | 'failed'

export type MediaRuntimeSupervisorSnapshot = {
  status: MediaRuntimeSupervisorStatus
  restartCount: number
  pid?: number
  ready?: MediaLifecycleReady
  failure?: MediaLifecycleFailure
  nextRetryAt?: number
}

type PendingRequest = {
  resolve(value: unknown): void
  reject(error: MediaLifecycleError): void
  timeout: ReturnType<typeof setTimeout>
}

export type MediaRuntimeSupervisorOptions = {
  createAdapter: MediaUtilityAdapterFactory
  handshakeTimeoutMs?: number
  restartDelaysMs?: readonly number[]
  requestId?: () => string
  now?: () => number
}

const DEFAULT_RESTART_DELAYS_MS = [250, 1_000] as const

export class MediaRuntimeSupervisor {
  private adapter: MediaUtilityAdapter | null = null
  private hostEpoch = 0
  private snapshot: MediaRuntimeSupervisorSnapshot = {
    status: 'stopped',
    restartCount: 0,
  }
  private readonly stateListeners = new Set<
    (snapshot: MediaRuntimeSupervisorSnapshot) => void
  >()
  private readonly eventListeners = new Set<
    (event: MediaLifecycleEvent) => void
  >()
  private readonly diagnosticListeners = new Set<
    (event: MediaLifecycleDiagnosticEvent) => void
  >()
  private readonly snapshotListeners = new Set<
    (snapshot: MediaEngineSnapshot) => void
  >()
  private readonly pending = new Map<string, PendingRequest>()
  private startPromise: Promise<MediaLifecycleReady> | null = null
  private resolveStart: ((ready: MediaLifecycleReady) => void) | null = null
  private rejectStart: ((error: MediaLifecycleError) => void) | null = null
  private handshakeTimer: ReturnType<typeof setTimeout> | null = null
  private restartTimer: ReturnType<typeof setTimeout> | null = null
  private restartAttempt = 0
  private requestSequence = 0
  private hasBeenReady = false
  private shuttingDown = false
  private lastPublicEventSequence = 0
  private latestEngineSnapshot: MediaEngineSnapshot | undefined
  private snapshotRecoveryPending = false

  constructor(private readonly options: MediaRuntimeSupervisorOptions) {}

  getSnapshot() {
    return this.snapshot
  }

  getPendingRequestCount() {
    return this.pending.size
  }

  onStateChange(listener: (snapshot: MediaRuntimeSupervisorSnapshot) => void) {
    this.stateListeners.add(listener)
    return () => this.stateListeners.delete(listener)
  }

  onEvent(listener: (event: MediaLifecycleEvent) => void) {
    this.eventListeners.add(listener)
    return () => this.eventListeners.delete(listener)
  }

  onDiagnostic(listener: (event: MediaLifecycleDiagnosticEvent) => void) {
    this.diagnosticListeners.add(listener)
    return () => this.diagnosticListeners.delete(listener)
  }

  onSnapshot(listener: (snapshot: MediaEngineSnapshot) => void) {
    this.snapshotListeners.add(listener)
    return () => this.snapshotListeners.delete(listener)
  }

  getLatestEngineSnapshot() {
    return this.latestEngineSnapshot
  }

  start() {
    if (this.snapshot.status === 'ready' && this.snapshot.ready) {
      return Promise.resolve(this.snapshot.ready)
    }
    if (this.startPromise) return this.startPromise
    if (this.shuttingDown) {
      return Promise.reject(
        mediaLifecycleError(
          'media_host_stopping',
          'Windows media utility host is shutting down',
          'start',
        ),
      )
    }
    this.clearRestartTimer()
    const recovering = this.hasBeenReady
    this.updateSnapshot({
      status: recovering ? 'recovering' : 'starting',
      failure: undefined,
      nextRetryAt: undefined,
      ready: undefined,
    })
    this.startPromise = new Promise<MediaLifecycleReady>((resolve, reject) => {
      this.resolveStart = resolve
      this.rejectStart = reject
    })
    const startPromise = this.startPromise
    try {
      const adapter = this.options.createAdapter()
      const epoch = ++this.hostEpoch
      this.adapter = adapter
      adapter.start({
        onMessage: (message) => this.handleMessage(adapter, epoch, message),
        onExit: (exit) => this.handleExit(adapter, epoch, exit),
      })
      this.updateSnapshot({ pid: adapter.pid })
      this.handshakeTimer = setTimeout(
        () => this.failHandshake(adapter, epoch),
        this.options.handshakeTimeoutMs ?? MEDIA_LIFECYCLE_HANDSHAKE_TIMEOUT_MS,
      )
      this.handshakeTimer.unref?.()
    } catch (cause) {
      this.adapter = null
      const error = mediaLifecycleError(
        'media_host_start_failed',
        cause instanceof Error ? cause.message : 'Media utility process failed to start',
        'host_start',
        true,
      )
      this.rejectStarting(error)
      this.scheduleRestart(error.failure)
    }
    return startPromise
  }

  startEffect() {
    return Effect.tryPromise({
      try: () => this.start(),
      catch: (cause) =>
        cause instanceof MediaLifecycleError
          ? cause
          : mediaLifecycleError(
              'media_host_start_failed',
              cause instanceof Error ? cause.message : String(cause),
              'host_start',
              true,
            ),
    })
  }

  ping() {
    return Effect.runPromise(this.pingEffect())
  }

  pingEffect() {
    return this.startEffect().pipe(
      Effect.flatMap(() =>
        Effect.tryPromise({
          try: () =>
            this.sendRequest(
              { type: 'ping' },
              MEDIA_LIFECYCLE_PING_TIMEOUT_MS,
            ).then((result) =>
              decodeCommandResult(
                MediaAddonPingSchema,
                result,
                'media_ping_invalid',
                'ping',
              ),
            ),
          catch: normalizeLifecycleError('ping'),
        }),
      ),
    )
  }

  handshake() {
    return this.start().then(() =>
      this.sendRequest(
        { type: 'handshake' },
        MEDIA_LIFECYCLE_PING_TIMEOUT_MS,
      ).then((result) =>
        decodeCommandResult(
          MediaLifecycleHandshakeResultSchema,
          result,
          'media_handshake_invalid',
          'handshake',
        ),
      ),
    )
  }

  installCredentialLease(lease: MediaCredentialLease) {
    return this.start().then(() =>
      this.sendRequest(
        { type: 'installCredentialLease', lease },
        MEDIA_LIFECYCLE_PING_TIMEOUT_MS,
      ).then((result) =>
        decodeCommandResult(
          MediaCredentialLeaseInstalledSchema,
          result,
          'media_credential_lease_invalid',
          'install_credential_lease',
        ),
      ),
    )
  }

  applyDesiredState(desiredState: EngineDesiredState) {
    return this.start().then(() =>
      this.sendRequest(
        { type: 'applyDesiredState', desiredState },
        MEDIA_LIFECYCLE_PING_TIMEOUT_MS,
      ).then((result) =>
        decodeCommandResult(
          MediaDesiredStateAcceptedSchema,
          result,
          'media_apply_invalid',
          'apply_desired_state',
        ),
      ),
    )
  }

  querySnapshot() {
    return this.start().then(() =>
      this.sendRequest(
        { type: 'querySnapshot' },
        MEDIA_LIFECYCLE_PING_TIMEOUT_MS,
      ).then((result) =>
        decodeCommandResult(
          MediaAddonSnapshotSchema,
          result,
          'media_snapshot_invalid',
          'query_snapshot',
        ).snapshot,
      ),
    )
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
              try: () =>
                this.sendRequest(
                  { type: 'shutdown' },
                  MEDIA_LIFECYCLE_SHUTDOWN_TIMEOUT_MS,
                ),
              catch: normalizeLifecycleError('shutdown'),
            }).pipe(Effect.ignore)
          : Effect.void
      return graceful.pipe(
        Effect.timeoutOrElse({
          duration: MEDIA_LIFECYCLE_OUTER_SHUTDOWN_MS,
          orElse: () => Effect.void,
        }),
        Effect.ensuring(
          Effect.sync(() => {
            if (this.adapter === adapter) adapter.kill()
            this.adapter = null
            const stopped = mediaLifecycleError(
              'media_host_stopped',
              'Windows media utility host stopped',
              'shutdown',
            )
            this.rejectStarting(stopped)
            this.rejectPending(stopped)
            this.finishStopped()
          }),
        ),
        Effect.asVoid,
      )
    })
  }

  private sendRequest(
    command: MediaLifecycleCommand,
    timeoutMs: number,
  ): Promise<MediaLifecycleResult> {
    const adapter = this.adapter
    if (!adapter || this.snapshot.status !== 'ready') {
      return Promise.reject(
        mediaLifecycleError(
          'media_host_unavailable',
          'Windows media utility host is not ready',
          command.type,
          true,
        ),
      )
    }
    if (this.pending.size >= MEDIA_LIFECYCLE_MAX_PENDING_REQUESTS) {
      return Promise.reject(
        mediaLifecycleError(
          'media_request_capacity_exceeded',
          'Windows media lifecycle request capacity is exhausted',
          command.type,
          true,
        ),
      )
    }
    const requestId = this.nextRequestId()
    const request: MediaLifecycleRequest = {
      type: 'request',
      protocolVersion: MEDIA_LIFECYCLE_PROTOCOL_VERSION,
      requestId,
      hostEpoch: this.hostEpoch,
      deadlineMs: timeoutMs,
      command,
    }
    return new Promise<MediaLifecycleResult>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(requestId)
        reject(
          mediaLifecycleError(
            'media_request_deadline_exceeded',
            'Windows media lifecycle request exceeded its deadline',
            command.type,
            true,
          ),
        )
      }, timeoutMs)
      timeout.unref?.()
      this.pending.set(requestId, { resolve, reject, timeout })
      try {
        adapter.postMessage(request)
      } catch (cause) {
        clearTimeout(timeout)
        this.pending.delete(requestId)
        reject(normalizeLifecycleError(command.type)(cause))
      }
    })
  }

  private handleMessage(
    adapter: MediaUtilityAdapter,
    epoch: number,
    rawMessage: unknown,
  ) {
    if (this.adapter !== adapter || epoch !== this.hostEpoch) return
    if (!isMediaLifecycleMessage(rawMessage)) {
      this.retireHost(
        adapter,
        epoch,
        mediaLifecycleError(
          'media_protocol_corrupt',
          'Windows media utility host emitted an invalid message',
          'protocol',
        ),
      )
      return
    }
    if (rawMessage.type === 'ready') {
      this.handleReady(adapter, epoch, rawMessage)
      return
    }
    if (rawMessage.type === 'reply') {
      this.handleReply(rawMessage)
      return
    }
    if (rawMessage.type === 'diagnostic') {
      for (const listener of this.diagnosticListeners) listener(rawMessage.event)
      return
    }
    const event = rawMessage.event
    const hasGap = event.sequence !== this.lastPublicEventSequence + 1
    this.lastPublicEventSequence = event.sequence
    for (const listener of this.eventListeners) listener(event)
    if (event.type === 'fatalEngineFailure') {
      this.retireHost(
        adapter,
        epoch,
        MediaLifecycleError.make({ failure: event.failure }),
      )
      return
    }
    if (hasGap) this.recoverSnapshot()
  }

  private handleReady(
    adapter: MediaUtilityAdapter,
    epoch: number,
    ready: MediaLifecycleReady,
  ) {
    if (this.snapshot.status !== 'starting' && this.snapshot.status !== 'recovering') {
      this.retireHost(
        adapter,
        epoch,
        mediaLifecycleError(
          'media_protocol_corrupt',
          'Windows media utility host emitted a duplicate handshake',
          'handshake',
        ),
      )
      return
    }
    if (ready.protocolVersion !== MEDIA_LIFECYCLE_PROTOCOL_VERSION) {
      this.retireHost(
        adapter,
        epoch,
        MediaLifecycleError.make({ failure: ready.failure }),
      )
      return
    }
    this.clearHandshakeTimer()
    const recovered = this.hasBeenReady
    this.hasBeenReady = true
    this.lastPublicEventSequence = 0
    this.latestEngineSnapshot = undefined
    this.snapshotRecoveryPending = false
    if (recovered) this.restartAttempt = 0
    this.updateSnapshot({
      status: 'ready',
      restartCount: this.snapshot.restartCount + (recovered ? 1 : 0),
      pid: adapter.pid,
      ready,
      failure: undefined,
      nextRetryAt: undefined,
    })
    const resolve = this.resolveStart
    this.clearStartPromise()
    resolve?.(ready)
  }

  private recoverSnapshot() {
    if (this.snapshotRecoveryPending) return
    this.snapshotRecoveryPending = true
    void this.querySnapshot().then((snapshot) => {
      this.latestEngineSnapshot = snapshot
      for (const listener of this.snapshotListeners) listener(snapshot)
    }).catch(() => {
      // Host retirement and request deadlines already surface through supervisor state.
    }).finally(() => {
      this.snapshotRecoveryPending = false
    })
  }

  private handleReply(reply: MediaLifecycleReply) {
    const pending = this.pending.get(reply.requestId)
    if (!pending) return
    clearTimeout(pending.timeout)
    this.pending.delete(reply.requestId)
    if (reply.ok) pending.resolve(reply.result)
    else pending.reject(MediaLifecycleError.make({ failure: reply.failure }))
  }

  private handleExit(
    adapter: MediaUtilityAdapter,
    epoch: number,
    exit: MediaUtilityExit,
  ) {
    if (this.adapter !== adapter || epoch !== this.hostEpoch) return
    this.clearHandshakeTimer()
    this.adapter = null
    if (this.shuttingDown || exit.expected) {
      const stopped = mediaLifecycleError(
        'media_host_stopped',
        'Windows media utility host stopped',
        'utility_process',
      )
      this.rejectStarting(stopped)
      this.rejectPending(stopped)
      this.finishStopped()
      return
    }
    const failure = mediaLifecycleFailure(
      'unexpected_exit',
      exit.error?.message ||
        `Windows media utility host exited unexpectedly with code ${exit.code ?? 'unknown'}`,
      'utility_process',
      true,
    )
    const error = MediaLifecycleError.make({ failure })
    this.rejectStarting(error)
    this.rejectPending(error)
    this.scheduleRestart(failure)
  }

  private failHandshake(adapter: MediaUtilityAdapter, epoch: number) {
    if (this.adapter !== adapter || epoch !== this.hostEpoch) return
    this.retireHost(
      adapter,
      epoch,
      mediaLifecycleError(
        'media_handshake_deadline_exceeded',
        'Windows media utility host handshake exceeded its deadline',
        'handshake',
        true,
      ),
    )
  }

  private retireHost(
    adapter: MediaUtilityAdapter,
    epoch: number,
    error: MediaLifecycleError,
  ) {
    if (this.adapter !== adapter || epoch !== this.hostEpoch) return
    this.clearHandshakeTimer()
    adapter.kill()
    this.adapter = null
    this.rejectStarting(error)
    this.rejectPending(error)
    this.scheduleRestart(error.failure)
  }

  private scheduleRestart(failure: MediaLifecycleFailure) {
    if (this.shuttingDown) {
      this.finishStopped()
      return
    }
    const delays = this.options.restartDelaysMs ?? DEFAULT_RESTART_DELAYS_MS
    const delay = delays[this.restartAttempt]
    if (delay === undefined) {
      this.updateSnapshot({
        status: 'failed',
        pid: undefined,
        ready: undefined,
        failure,
        nextRetryAt: undefined,
      })
      return
    }
    this.restartAttempt += 1
    const now = this.options.now?.() ?? Date.now()
    this.updateSnapshot({
      status: 'recovering',
      pid: undefined,
      ready: undefined,
      failure,
      nextRetryAt: now + delay,
    })
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null
      void this.start().catch(() => undefined)
    }, delay)
    this.restartTimer.unref?.()
  }

  private rejectStarting(error: MediaLifecycleError) {
    const reject = this.rejectStart
    this.clearStartPromise()
    reject?.(error)
  }

  private rejectPending(error: MediaLifecycleError) {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timeout)
      pending.reject(error)
    }
    this.pending.clear()
  }

  private finishStopped() {
    this.clearHandshakeTimer()
    this.clearRestartTimer()
    this.clearStartPromise()
    this.updateSnapshot({
      status: 'stopped',
      pid: undefined,
      ready: undefined,
      failure: undefined,
      nextRetryAt: undefined,
    })
  }

  private clearStartPromise() {
    this.startPromise = null
    this.resolveStart = null
    this.rejectStart = null
  }

  private clearHandshakeTimer() {
    if (this.handshakeTimer) clearTimeout(this.handshakeTimer)
    this.handshakeTimer = null
  }

  private clearRestartTimer() {
    if (this.restartTimer) clearTimeout(this.restartTimer)
    this.restartTimer = null
  }

  private nextRequestId() {
    if (this.options.requestId) return this.options.requestId()
    this.requestSequence += 1
    return `media-${this.hostEpoch}-${this.requestSequence}`
  }

  private updateSnapshot(patch: Partial<MediaRuntimeSupervisorSnapshot>) {
    this.snapshot = { ...this.snapshot, ...patch }
    for (const listener of this.stateListeners) listener(this.snapshot)
  }
}

function normalizeLifecycleError(stage: string) {
  return (cause: unknown) =>
    cause instanceof MediaLifecycleError
      ? cause
      : mediaLifecycleError(
          'media_lifecycle_failure',
          cause instanceof Error ? cause.message : String(cause),
          stage,
        )
}

function decodeCommandResult<S extends Schema.ConstraintDecoder<unknown>>(
  schema: S,
  value: unknown,
  code: string,
  stage: string,
): S['Type'] {
  const decoded = Schema.decodeUnknownOption(schema, {
    onExcessProperty: 'error',
  })(value)
  if (Option.isSome(decoded)) return decoded.value
  throw mediaLifecycleError(
    code,
    'Media utility host returned an invalid command result',
    stage,
  )
}
