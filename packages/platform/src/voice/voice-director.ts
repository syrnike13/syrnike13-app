import { Effect, Fiber, Layer, ManagedRuntime, Option, Schema } from 'effect'

import type {
  VoiceAuthorityAdapter,
  VoiceAuthorityEvent,
  VoiceCancellation,
} from './voice-authority'
import type {
  RtcEngineAdapter,
  VoiceDisconnectCause,
  VoiceEngineEvent,
} from './voice-engine'
import {
  areVoiceMediaDesiredStatesEqual,
  computeEffectiveMuted,
  createInactiveMediaSnapshot,
  createInitialVoiceMediaDesiredState,
  type AuthoritativeVoiceSnapshot,
  type VoiceCommand,
  type VoiceFailure,
  type VoiceLease,
  type VoiceMediaDesiredState,
  type VoiceMediaKind,
  type VoiceRtcEngine,
  type VoiceSnapshot,
} from './voice-types'

const DEFAULT_COMMIT_TIMEOUT_MS = 20_000
const DEFAULT_RECOVERY_DELAYS_MS = [250, 1_000, ...Array(18).fill(5_000)]

export type VoiceDirectorOptions = Readonly<{
  authority: VoiceAuthorityAdapter
  engine: RtcEngineAdapter
  rtcEngine: VoiceRtcEngine
  clientInstanceId: string
  createOperationId?: () => string
  createConnectionEpoch?: () => string
  commitTimeoutMs?: number
  recoveryDelaysMs?: readonly number[]
  delay?: (milliseconds: number, signal: AbortSignal) => Promise<void>
}>

type CommitWaiter = {
  lease: VoiceLease
  resolve: () => void
}

const VoiceFailureSchema = Schema.Struct({
  code: Schema.String,
  message: Schema.String,
  retryable: Schema.Boolean,
  stage: Schema.optional(Schema.String),
  hresult: Schema.optional(Schema.Number),
})

const FailureCarrierSchema = Schema.Struct({
  failure: VoiceFailureSchema,
})

class VoiceDirectorOperationError extends Schema.ErrorClass<VoiceDirectorOperationError>(
  'syrnike13/VoiceDirectorOperationError',
)({
  _tag: Schema.tag('VoiceDirectorOperationError'),
  message: Schema.String,
  failure: VoiceFailureSchema,
}) {}

export class VoiceDirector {
  private readonly listeners = new Set<(snapshot: VoiceSnapshot) => void>()
  private readonly runtime = ManagedRuntime.make(Layer.empty)
  private readonly authority: VoiceAuthorityAdapter
  private readonly engine: RtcEngineAdapter
  private readonly rtcEngine: VoiceRtcEngine
  private readonly clientInstanceId: string
  private readonly createOperationId: () => string
  private readonly createConnectionEpoch: () => string
  private readonly commitTimeoutMs: number
  private readonly recoveryDelaysMs: readonly number[]
  private readonly delay:
    | ((milliseconds: number, signal: AbortSignal) => Promise<void>)
    | null
  private readonly commitWaiters = new Set<CommitWaiter>()

  private desiredMedia = createInitialVoiceMediaDesiredState()
  private desiredChannelId: string | null = null
  private desiredRecipients: readonly string[] | undefined
  private desiredRevision = 0
  private activeLease: VoiceLease | null = null
  private forcedLease: VoiceLease | null = null
  private activeCommitted = false
  private latestAuthoritySnapshot: AuthoritativeVoiceSnapshot | null = null
  private transitionInProgress = false
  private recoveryRequested = false
  private reconcileRequested = false
  private reconcileFiber: Fiber.Fiber<void, never> | null = null
  private operationAbort: AbortController | null = null
  private engineAvailable = true
  private engineAvailabilityFailure: VoiceFailure | undefined
  private readonly engineAvailabilityWaiters = new Set<() => void>()
  private terminalCleanupRequested = false
  private selfStateRevision = 0
  private selfStateHandledRevision = 0
  private selfStateSync: Fiber.Fiber<void, never> | null = null
  private disposed = false
  private idCounter = 0

  private snapshotValue: VoiceSnapshot = {
    intentChannelId: null,
    membershipChannelId: null,
    connection: 'disconnected',
    microphone: createInactiveMediaSnapshot(),
    output: createInactiveMediaSnapshot(),
    camera: createInactiveMediaSnapshot(),
    screen: createInactiveMediaSnapshot(),
    screenAudio: createInactiveMediaSnapshot(),
    userMuted: this.desiredMedia.userMuted,
    userDeafened: this.desiredMedia.userDeafened,
    serverMuted: this.desiredMedia.serverMuted,
    serverDeafened: this.desiredMedia.serverDeafened,
    systemPrivacyMuted: this.desiredMedia.systemPrivacyMuted,
    monitoringMuted: this.desiredMedia.monitoringMuted,
    inputMode: this.desiredMedia.inputMode,
    pushToTalkHeld: this.desiredMedia.pushToTalkHeld,
    effectiveMuted: this.desiredMedia.effectiveMuted,
    speakingUserIds: [],
  }

  private readonly unsubscribeAuthority: () => void
  private readonly unsubscribeEngine: () => void

  constructor(options: VoiceDirectorOptions) {
    this.authority = options.authority
    this.engine = options.engine
    this.rtcEngine = options.rtcEngine
    this.clientInstanceId = requireIdentifier(
      options.clientInstanceId,
      'clientInstanceId',
    )
    this.createOperationId =
      options.createOperationId ?? (() => this.createUniqueId('voice-op'))
    this.createConnectionEpoch =
      options.createConnectionEpoch ?? (() => this.createUniqueId('voice-epoch'))
    this.commitTimeoutMs =
      options.commitTimeoutMs ?? DEFAULT_COMMIT_TIMEOUT_MS
    this.recoveryDelaysMs =
      options.recoveryDelaysMs ?? DEFAULT_RECOVERY_DELAYS_MS
    this.delay = options.delay ?? null
    this.unsubscribeAuthority = this.authority.subscribe((event) =>
      this.handleAuthorityEvent(event),
    )
    this.unsubscribeEngine = this.engine.subscribe((event) =>
      this.handleEngineEvent(event),
    )
  }

  dispatch(command: VoiceCommand) {
    if (this.disposed) return
    switch (command.type) {
      case 'join':
        this.join(command.channelId, command.recipients)
        return
      case 'leave':
        this.forcedLease = null
        this.setIntent(null, false)
        return
      case 'retryVoice':
        if (!this.desiredChannelId || this.snapshotValue.connection !== 'failed') {
          return
        }
        this.recoveryRequested = false
        this.forcedLease = null
        this.bumpIntentRevision()
        return
      case 'retryMedia':
        this.engine.retryMedia(command.kind)
        return
      case 'setUserMuted':
        this.updateDesiredMedia({ userMuted: command.muted })
        return
      case 'setUserDeafened':
        this.updateDesiredMedia({ userDeafened: command.deafened })
        return
      case 'setInputMode':
        this.updateDesiredMedia({ inputMode: command.mode })
        return
      case 'setPushToTalkHeld':
        this.updateDesiredMedia({ pushToTalkHeld: command.held })
        return
      case 'setSystemPrivacyMuted':
        this.updateDesiredMedia({ systemPrivacyMuted: command.muted })
        return
      case 'setSelfMonitoringActive':
        this.updateDesiredMedia({ monitoringMuted: command.active })
        return
      case 'configureMicrophone':
        this.updateDesiredMedia({
          microphoneDeviceId: command.deviceId,
          bypassSystemAudioInputProcessing:
            command.bypassSystemAudioInputProcessing,
          automaticGainControl: command.automaticGainControl,
          noiseSuppression: command.noiseSuppression,
          echoCancellation: command.echoCancellation,
          inputVolume: command.inputVolume,
          voiceGateEnabled: command.voiceGateEnabled,
          voiceGateThresholdDb: command.voiceGateThresholdDb,
          voiceGateAutoThreshold: command.voiceGateAutoThreshold,
        })
        return
      case 'configureOutput':
        this.updateDesiredMedia({
          outputDeviceId: command.deviceId,
          outputVolume: command.volume,
        })
        return
      case 'configureRemoteAudio':
        this.engine.updateRemoteAudioSettings(command.settings)
        return
      case 'setCamera':
        this.updateDesiredMedia({
          cameraEnabled: command.enabled,
          cameraDeviceId: command.deviceId,
        })
        return
      case 'setScreen':
        this.updateDesiredMedia({
          screenEnabled: command.enabled,
          screenSourceId: command.sourceId,
          screenAudioEnabled: command.enabled && Boolean(command.audioEnabled),
          screenWidth: command.width,
          screenHeight: command.height,
          screenFps: command.fps,
          screenBitrate: command.bitrate,
          screenAudioBitrate: command.audioBitrate,
        })
        return
    }
  }

  snapshot() {
    return this.snapshotValue
  }

  subscribe(listener: (snapshot: VoiceSnapshot) => void) {
    this.listeners.add(listener)
    listener(this.snapshotValue)
    return () => this.listeners.delete(listener)
  }

  waitForIdleEffect() {
    const self = this
    return Effect.gen(function*() {
      while (self.reconcileFiber) {
        const fiber = self.reconcileFiber
        yield* Fiber.join(fiber)
      }
    })
  }

  waitForIdle() {
    return this.runtime.runPromise(this.waitForIdleEffect())
  }

  shutdownEffect(reason: 'app_exit' | 'sleep' | 'logout') {
    const self = this
    return Effect.gen(function*() {
      if (self.disposed) return
      self.terminalCleanupRequested = false
      self.resetCameraAndScreenForIntentChange(null)
      self.desiredChannelId = null
      self.desiredRevision += 1
      self.recoveryRequested = false
      self.operationAbort?.abort(reason)
      self.updateSnapshot({ intentChannelId: null })
      self.requestReconcile()
      yield* self.waitForIdleEffect()
    })
  }

  shutdown(reason: 'app_exit' | 'sleep' | 'logout') {
    return this.runtime.runPromise(this.shutdownEffect(reason))
  }

  disposeEffect() {
    const self = this
    return Effect.gen(function*() {
      if (self.disposed) return
      yield* self.shutdownEffect('app_exit')
      self.disposed = true
      self.unsubscribeAuthority()
      self.unsubscribeEngine()
      self.listeners.clear()
      self.commitWaiters.clear()
      self.engineAvailabilityWaiters.clear()
      yield* self.runtime.disposeEffect
    })
  }

  dispose() {
    return this.runtime.runPromise(this.disposeEffect())
  }

  private join(channelId: string, recipients?: readonly string[]) {
    const normalized = requireIdentifier(channelId, 'channelId')
    if (
      this.desiredChannelId === normalized &&
      this.snapshotValue.connection !== 'failed'
    ) {
      return
    }
    this.forcedLease = null
    this.desiredRecipients = recipients ? [...recipients] : undefined
    this.setIntent(normalized, false)
  }

  private setIntent(channelId: string | null, recovery: boolean) {
    this.resetCameraAndScreenForIntentChange(channelId)
    this.desiredChannelId = channelId
    if (channelId === null) this.desiredRecipients = undefined
    this.recoveryRequested = recovery
    this.bumpIntentRevision()
  }

  private bumpIntentRevision() {
    this.terminalCleanupRequested = false
    this.desiredRevision += 1
    this.operationAbort?.abort('superseded')
    this.updateSnapshot({
      intentChannelId: this.desiredChannelId,
      failure: undefined,
      retryAttempt: undefined,
    })
    this.requestReconcile()
  }

  private requestReconcile() {
    this.reconcileRequested = true
    if (this.reconcileFiber) return

    let fiber: Fiber.Fiber<void, never> | null = null
    const effect = this.runReconcileLoopEffect().pipe(
      Effect.ignore,
      Effect.ensuring(
        Effect.sync(() => {
          if (fiber && this.reconcileFiber === fiber) {
            this.reconcileFiber = null
          }
          if (this.reconcileRequested && !this.disposed) this.requestReconcile()
        }),
      ),
    )
    const startedFiber = this.runtime.runFork(effect)
    fiber = startedFiber
    if (startedFiber.pollUnsafe()) {
      if (this.reconcileRequested && !this.disposed) this.requestReconcile()
      return
    }
    this.reconcileFiber = startedFiber
  }

  private runReconcileLoopEffect() {
    const self = this
    return Effect.gen(function*() {
      while (self.reconcileRequested && !self.disposed) {
        self.reconcileRequested = false
        const revision = self.desiredRevision
        yield* self.reconcileOnceEffect(revision)
      }
    })
  }

  private reconcileOnceEffect(revision: number) {
    const self = this
    return Effect.gen(function*() {
      const target = self.desiredChannelId
      if (self.terminalCleanupRequested) {
        const terminalFailure = self.snapshotValue.failure
        self.terminalCleanupRequested = false
        yield* self.cleanupFailedAttemptEffect('connect_failed')
        if (revision !== self.desiredRevision) return
        self.updateSnapshot({
          connection: 'failed',
          membershipChannelId: null,
          speakingUserIds: [],
          retryAttempt: undefined,
          failure: terminalFailure,
        })
        return
      }
      if (!target) {
        yield* self.disconnectCurrentEffect('leave')
        if (revision !== self.desiredRevision) return
        self.updateSnapshot({
          connection: 'disconnected',
          membershipChannelId: null,
          speakingUserIds: [],
          operationId: undefined,
          connectionEpoch: undefined,
          retryAttempt: undefined,
          failure: undefined,
        })
        return
      }

      if (
        self.activeLease?.channelId === target &&
        self.activeCommitted &&
        self.snapshotValue.connection === 'connected'
      ) {
        return
      }

      if (self.activeLease) {
        yield* self.disconnectCurrentEffect(
          self.activeLease.channelId === target ? 'recovery' : 'move',
        )
        if (revision !== self.desiredRevision) return
      }

      const recovery = self.recoveryRequested
      const delays = recovery ? self.recoveryDelaysMs : [0]
      let lastFailure: VoiceFailure | undefined

      let index = 0
      while (index < delays.length) {
        if (
          revision !== self.desiredRevision ||
          target !== self.desiredChannelId
        ) {
          return
        }

        const abort = new AbortController()
        self.operationAbort = abort
        const attempt = index + 1
        const result = yield* Effect.gen(function*() {
          if (recovery && !self.engineAvailable) {
            self.updateSnapshot({
              connection: 'recovering',
              retryAttempt: attempt,
              failure: lastFailure,
            })
            yield* self.waitForEngineAvailabilityEffect(abort.signal)
          }
          if (delays[index] > 0) {
            self.updateSnapshot({
              connection: 'recovering',
              retryAttempt: attempt,
              failure: lastFailure,
            })
            yield* self.delayEffect(delays[index], abort.signal)
          }
          yield* self.connectTargetEffect(
            target,
            revision,
            recovery,
            attempt,
            abort,
          )
        }).pipe(
          Effect.match({
            onFailure: (error) => ({ success: false, error }),
            onSuccess: () => ({ success: true, error: undefined }),
          }),
        )

        if (self.operationAbort === abort) self.operationAbort = null
        if (result.success) {
          self.recoveryRequested = false
          return
        }

        const error = result.error
        if (
          isAbortError(error) ||
          revision !== self.desiredRevision ||
          target !== self.desiredChannelId
        ) {
          yield* self.cleanupFailedAttemptEffect('superseded')
          return
        }
        lastFailure = normalizeFailure(error, 'voice_connect_failed')
        yield* self.cleanupFailedAttemptEffect('connect_failed')
        if (
          !lastFailure.retryable ||
          !recovery ||
          index === delays.length - 1
        ) {
          self.updateSnapshot({
            connection: 'failed',
            membershipChannelId: null,
            retryAttempt: recovery ? attempt : undefined,
            failure: lastFailure,
          })
          return
        }
        // Runtime recovery owns host restart/backoff. Do not consume Voice
        // Recovery attempts while that runtime is unavailable.
        if (self.engineAvailable) index += 1
      }
    })
  }

  private connectTargetEffect(
    channelId: string,
    revision: number,
    recovery: boolean,
    attempt: number,
    abort: AbortController,
  ) {
    const self = this
    return Effect.gen(function*() {
      const suppliedLease =
        self.forcedLease?.channelId === channelId ? self.forcedLease : null
      if (suppliedLease) self.forcedLease = null
      const { operationId, connectionEpoch } = yield* Effect.try({
        try: () => ({
          operationId: suppliedLease
            ? suppliedLease.operationId
            : requireIdentifier(self.createOperationId(), 'operationId'),
          connectionEpoch: suppliedLease
            ? suppliedLease.connectionEpoch
            : requireIdentifier(
                self.createConnectionEpoch(),
                'connectionEpoch',
              ),
        }),
        catch: (error) => error,
      })
      self.transitionInProgress = true
      self.activeCommitted = false
      self.updateSnapshot({
        connection: recovery ? 'recovering' : 'connecting',
        speakingUserIds: [],
        operationId,
        connectionEpoch,
        retryAttempt: recovery ? attempt : undefined,
        failure: undefined,
        membershipChannelId: null,
      })

      const lease =
        suppliedLease ??
        (yield* Effect.tryPromise({
          try: () =>
            self.authority.reserve(
              {
                channelId,
                rtcEngine: self.rtcEngine,
                clientInstanceId: self.clientInstanceId,
                operationId,
                connectionEpoch,
                media: self.desiredMedia,
                recipients: self.desiredRecipients,
                suppressCallNotifications: recovery,
              },
              abort.signal,
            ),
          catch: (error) => error,
        }))
      yield* Effect.try({
        try: () =>
          assertLeaseMatches(lease, {
            channelId,
            rtcEngine: self.rtcEngine,
            clientInstanceId: self.clientInstanceId,
            operationId,
            connectionEpoch,
          }),
        catch: (error) => error,
      })
      if (revision !== self.desiredRevision) yield* Effect.fail(abortError())
      self.activeLease = lease
      yield* Effect.tryPromise({
        try: () => self.engine.connect(lease, self.desiredMedia, abort.signal),
        catch: (error) => error,
      })
      if (revision !== self.desiredRevision) yield* Effect.fail(abortError())
      yield* self.waitForMembershipCommitEffect(lease, abort.signal)
      if (revision !== self.desiredRevision) yield* Effect.fail(abortError())
      self.activeCommitted = true
      self.requestSelfStateSync()
      self.updateSnapshot({
        connection: 'connected',
        membershipChannelId: channelId,
        operationId,
        connectionEpoch,
        retryAttempt: undefined,
        failure: undefined,
      })
    }).pipe(
      Effect.ensuring(
        Effect.sync(() => {
          self.transitionInProgress = false
        }),
      ),
    )
  }

  private waitForEngineAvailabilityEffect(signal: AbortSignal) {
    return Effect.callback<
      void,
      VoiceDirectorOperationError | DOMException
    >((resume) => {
      const onAvailable = () => {
        if (this.engineAvailable) {
          resume(Effect.void)
        } else if (this.engineAvailabilityFailure?.retryable === false) {
          resume(Effect.fail(failureError(this.engineAvailabilityFailure)))
        }
      }
      this.engineAvailabilityWaiters.add(onAvailable)
      onAvailable()
      return Effect.sync(() =>
        this.engineAvailabilityWaiters.delete(onAvailable),
      )
    }).pipe(Effect.raceFirst(abortSignal(signal)))
  }

  private delayEffect(milliseconds: number, signal: AbortSignal) {
    const delay = this.delay
    if (!delay) return abortableDelay(milliseconds, signal)
    return Effect.tryPromise({
      try: () => delay(milliseconds, signal),
      catch: (error) => error,
    })
  }

  private disconnectCurrentEffect(cause: VoiceDisconnectCause) {
    const self = this
    return Effect.gen(function*() {
      const lease = self.activeLease
      if (!lease) {
        if (cause === 'leave' || cause === 'move') {
          self.clearCameraAndScreenIntent()
        }
        return
      }
      self.transitionInProgress = true
      self.activeLease = null
      self.activeCommitted = false
      if (cause === 'leave' || cause === 'move') {
        // The adapter owns physical teardown. Clearing desired state here keeps
        // the next Voice Session from replaying camera or screen while avoiding
        // a competing media reconcile against the Room being disconnected.
        self.clearCameraAndScreenIntent()
      }
      yield* Effect.tryPromise({
        try: () => self.engine.disconnect(cause),
        catch: (error) => error,
      }).pipe(Effect.ignore)
      yield* self.cancelLeaseEffect(
        lease,
        cause === 'leave' ? 'leave' : 'superseded',
      )
    }).pipe(
      Effect.ensuring(
        Effect.sync(() => {
          self.transitionInProgress = false
        }),
      ),
    )
  }

  private cleanupFailedAttemptEffect(reason: VoiceCancellation['reason']) {
    const self = this
    return Effect.gen(function*() {
      const lease = self.activeLease
      self.activeLease = null
      self.activeCommitted = false
      yield* Effect.tryPromise({
        try: () => self.engine.disconnect('recovery'),
        catch: (error) => error,
      }).pipe(Effect.ignore)
      if (lease) yield* self.cancelLeaseEffect(lease, reason)
    })
  }

  private cancelLeaseEffect(
    lease: VoiceLease,
    reason: VoiceCancellation['reason'],
  ) {
    return Effect.tryPromise({
      try: () =>
        this.authority.cancel({
          rtcEngine: lease.rtcEngine,
          clientInstanceId: lease.clientInstanceId,
          operationId: lease.operationId,
          connectionEpoch: lease.connectionEpoch,
          reason,
        }),
      catch: (error) => error,
    }).pipe(Effect.ignore)
  }

  private waitForMembershipCommitEffect(
    lease: VoiceLease,
    signal: AbortSignal,
  ) {
    if (membershipMatchesLease(this.latestAuthoritySnapshot?.membership, lease)) {
      return Effect.void
    }

    return Effect.callback<void, VoiceDirectorOperationError>((resume) => {
      const waiter: CommitWaiter = {
        lease,
        resolve: () => resume(Effect.void),
      }
      this.commitWaiters.add(waiter)
      if (membershipMatchesLease(this.latestAuthoritySnapshot?.membership, lease)) {
        waiter.resolve()
      }
      return Effect.sync(() => this.commitWaiters.delete(waiter))
    }).pipe(
      Effect.timeoutOrElse({
        duration: this.commitTimeoutMs,
        orElse: () =>
          Effect.fail(
            failureError({
              code: 'voice_commit_timeout',
              message: 'Voice membership commit timed out',
              retryable: true,
              stage: 'authority_commit',
            }),
          ),
      }),
      Effect.raceFirst(abortSignal(signal)),
    )
  }

  private handleAuthorityEvent(event: VoiceAuthorityEvent) {
    if (this.disposed) return
    if (event.type === 'forcedMove') {
      this.handleForcedMove(event.from, event.lease)
      return
    }
    if (event.type !== 'snapshot') return
    const incoming = event.snapshot
    if (
      this.latestAuthoritySnapshot &&
      incoming.authorityVersion <= this.latestAuthoritySnapshot.authorityVersion
    ) {
      return
    }
    this.latestAuthoritySnapshot = incoming
    this.updateDesiredMedia(
      {
        serverMuted: incoming.serverMuted,
        serverDeafened: incoming.serverDeafened,
      },
    )
    for (const waiter of [...this.commitWaiters]) {
      if (membershipMatchesLease(incoming.membership, waiter.lease)) waiter.resolve()
    }

    const lease = this.activeLease
    if (
      !lease ||
      !this.activeCommitted ||
      this.transitionInProgress ||
      this.snapshotValue.connection !== 'connected'
    ) {
      return
    }
    if (membershipMatchesLease(incoming.membership, lease)) return
    if (incoming.authorityVersion <= lease.authorityVersion) return

    this.setIntent(null, false)
  }

  private handleForcedMove(
    from: NonNullable<AuthoritativeVoiceSnapshot['membership']>,
    lease: VoiceLease,
  ) {
    const current = this.activeLease
    if (
      sameVoiceLease(this.forcedLease, lease) ||
      sameVoiceLease(current, lease)
    ) {
      return
    }
    const acceptsMove =
      current !== null &&
      this.activeCommitted &&
      !this.transitionInProgress &&
      membershipMatchesLease(from, current) &&
      lease.rtcEngine === this.rtcEngine &&
      lease.clientInstanceId === this.clientInstanceId &&
      lease.channelId !== current.channelId &&
      lease.authorityVersion > current.authorityVersion

    if (!acceptsMove) {
      this.runtime.runFork(this.cancelLeaseEffect(lease, 'superseded'))
      return
    }

    this.forcedLease = lease
    this.desiredRecipients = undefined
    this.setIntent(lease.channelId, false)
  }

  private resetCameraAndScreenForIntentChange(
    nextChannelId: string | null,
  ) {
    if (
      this.desiredChannelId === null ||
      this.desiredChannelId === nextChannelId
    ) {
      return
    }
    this.clearCameraAndScreenIntent()
  }

  private clearCameraAndScreenIntent() {
    const desiredChanged =
      this.desiredMedia.cameraEnabled ||
      this.desiredMedia.screenEnabled ||
      this.desiredMedia.screenAudioEnabled ||
      this.desiredMedia.screenSourceId !== undefined ||
      this.desiredMedia.screenWidth !== undefined ||
      this.desiredMedia.screenHeight !== undefined ||
      this.desiredMedia.screenFps !== undefined ||
      this.desiredMedia.screenBitrate !== undefined ||
      this.desiredMedia.screenAudioBitrate !== undefined
    if (desiredChanged) {
      this.desiredMedia = {
        ...this.desiredMedia,
        cameraEnabled: false,
        screenEnabled: false,
        screenSourceId: undefined,
        screenAudioEnabled: false,
        screenWidth: undefined,
        screenHeight: undefined,
        screenFps: undefined,
        screenBitrate: undefined,
        screenAudioBitrate: undefined,
      }
    }

    if (
      this.snapshotValue.camera.state !== 'off' ||
      this.snapshotValue.screen.state !== 'off' ||
      this.snapshotValue.screenAudio.state !== 'off'
    ) {
      this.updateSnapshot({
        camera: createInactiveMediaSnapshot(),
        screen: createInactiveMediaSnapshot(),
        screenAudio: createInactiveMediaSnapshot(),
      })
    }
  }

  private handleEngineEvent(event: VoiceEngineEvent) {
    if (this.disposed) return
    if (event.type === 'availabilityChanged') {
      this.engineAvailable = event.available
      this.engineAvailabilityFailure = event.failure
      for (const resolve of [...this.engineAvailabilityWaiters]) resolve()
      return
    }
    const lease = this.activeLease
    if (
      !lease ||
      event.operationId !== lease.operationId ||
      event.connectionEpoch !== lease.connectionEpoch
    ) {
      return
    }
    if (event.type === 'mediaState') {
      this.updateMediaSnapshot(event.kind, event.media)
      return
    }
    if (event.type === 'transientReconnectStarted') {
      if (this.activeCommitted) this.updateSnapshot({ connection: 'recovering' })
      return
    }
    if (event.type === 'transientReconnectSucceeded') {
      if (this.activeCommitted) this.updateSnapshot({ connection: 'connected' })
      return
    }
    if (event.type === 'speakingChanged') {
      this.updateSnapshot({
        speakingUserIds: [...new Set(event.participantIdentities)],
      })
      return
    }
    if (event.type === 'terminalFailure') {
      if (!this.activeCommitted) return
      this.recoveryRequested = event.failure.retryable
      this.terminalCleanupRequested = !event.failure.retryable
      this.desiredRevision += 1
      this.operationAbort?.abort('runtime_lost')
      this.updateSnapshot({
        connection: event.failure.retryable ? 'recovering' : 'failed',
        membershipChannelId: null,
        speakingUserIds: [],
        retryAttempt: event.failure.retryable ? 0 : undefined,
        failure: event.failure,
      })
      this.requestReconcile()
    }
  }

  private updateDesiredMedia(
    patch: Partial<VoiceMediaDesiredState>,
  ) {
    const previousUserMuted = this.desiredMedia.userMuted
    const previousUserDeafened = this.desiredMedia.userDeafened
    const nextBase = { ...this.desiredMedia, ...patch }
    const nextDesired = {
      ...nextBase,
      effectiveMuted: computeEffectiveMuted(nextBase),
    }
    if (areVoiceMediaDesiredStatesEqual(this.desiredMedia, nextDesired)) return
    this.desiredMedia = nextDesired
    this.engine.updateDesiredMedia(this.desiredMedia)
    this.updateSnapshot({
      userMuted: this.desiredMedia.userMuted,
      userDeafened: this.desiredMedia.userDeafened,
      serverMuted: this.desiredMedia.serverMuted,
      serverDeafened: this.desiredMedia.serverDeafened,
      systemPrivacyMuted: this.desiredMedia.systemPrivacyMuted,
      monitoringMuted: this.desiredMedia.monitoringMuted,
      inputMode: this.desiredMedia.inputMode,
      pushToTalkHeld: this.desiredMedia.pushToTalkHeld,
      effectiveMuted: this.desiredMedia.effectiveMuted,
    })
    if (
      previousUserMuted !== this.desiredMedia.userMuted ||
      previousUserDeafened !== this.desiredMedia.userDeafened
    ) {
      this.requestSelfStateSync()
    }
  }

  private requestSelfStateSync() {
    this.selfStateRevision += 1
    this.ensureSelfStateSync()
  }

  private ensureSelfStateSync() {
    if (this.selfStateSync || !this.activeLease) return
    let fiber: Fiber.Fiber<void, never> | null = null
    const effect = this.runSelfStateSyncEffect().pipe(
      Effect.ignore,
      Effect.ensuring(
        Effect.sync(() => {
          if (fiber && this.selfStateSync === fiber) {
            this.selfStateSync = null
          }
          if (
            this.activeLease &&
            this.selfStateHandledRevision !== this.selfStateRevision
          ) {
            this.ensureSelfStateSync()
          }
        }),
      ),
    )
    const startedFiber = this.runtime.runFork(effect)
    fiber = startedFiber
    if (startedFiber.pollUnsafe()) {
      if (
        this.activeLease &&
        this.selfStateHandledRevision !== this.selfStateRevision
      ) {
        this.ensureSelfStateSync()
      }
      return
    }
    this.selfStateSync = startedFiber
  }

  private runSelfStateSyncEffect() {
    const self = this
    return Effect.gen(function*() {
      let handledRevision = -1
      while (
        self.activeLease &&
        handledRevision !== self.selfStateRevision
      ) {
        handledRevision = self.selfStateRevision
        const lease = self.activeLease
        const desired = self.desiredMedia
        yield* Effect.tryPromise({
          try: () =>
            self.authority.updateSelfState({
              channelId: lease.channelId,
              rtcEngine: lease.rtcEngine,
              clientInstanceId: lease.clientInstanceId,
              operationId: lease.operationId,
              connectionEpoch: lease.connectionEpoch,
              userMuted: desired.userMuted,
              userDeafened: desired.userDeafened,
            }),
          catch: (error) => error,
        }).pipe(Effect.ignore)
        // The next full authority snapshot remains canonical. A reconnect or
        // later user change retries without touching the healthy RTC Room.
        self.selfStateHandledRevision = handledRevision
      }
    })
  }

  private updateMediaSnapshot(
    kind: VoiceMediaKind,
    media: VoiceSnapshot['microphone'],
  ) {
    const key = kind === 'screen_audio' ? 'screenAudio' : kind
    this.updateSnapshot({ [key]: media })
  }

  private updateSnapshot(patch: Partial<VoiceSnapshot>) {
    this.snapshotValue = { ...this.snapshotValue, ...patch }
    for (const listener of this.listeners) listener(this.snapshotValue)
  }

  private createUniqueId(prefix: string) {
    const uuid = globalThis.crypto?.randomUUID?.()
    if (uuid) return `${prefix}-${uuid}`
    this.idCounter += 1
    return `${prefix}-${Date.now().toString(36)}-${this.idCounter.toString(36)}`
  }
}

function sameVoiceLease(left: VoiceLease | null, right: VoiceLease) {
  return (
    left !== null &&
    left.channelId === right.channelId &&
    left.rtcEngine === right.rtcEngine &&
    left.clientInstanceId === right.clientInstanceId &&
    left.operationId === right.operationId &&
    left.connectionEpoch === right.connectionEpoch
  )
}

function requireIdentifier(value: string, field: string) {
  const normalized = value.trim()
  if (!normalized || normalized.length > 512) {
    throw new Error(`${field} must be a non-empty identifier`)
  }
  return normalized
}

function assertLeaseMatches(
  lease: VoiceLease,
  expected: Omit<VoiceLease, 'authorityVersion' | 'credential'>,
) {
  if (
    lease.channelId !== expected.channelId ||
    lease.rtcEngine !== expected.rtcEngine ||
    lease.clientInstanceId !== expected.clientInstanceId ||
    lease.operationId !== expected.operationId ||
    lease.connectionEpoch !== expected.connectionEpoch
  ) {
    throw failureError({
      code: 'voice_lease_mismatch',
      message: 'Voice authority returned a mismatched credential lease',
      retryable: false,
      stage: 'authority_reserve',
    })
  }
}

function membershipMatchesLease(
  membership: AuthoritativeVoiceSnapshot['membership'] | undefined,
  lease: VoiceLease,
) {
  return (
    membership?.channelId === lease.channelId &&
    membership.rtcEngine === lease.rtcEngine &&
    membership.clientInstanceId === lease.clientInstanceId &&
    membership.operationId === lease.operationId &&
    membership.connectionEpoch === lease.connectionEpoch
  )
}

function failureError(failure: VoiceFailure) {
  return operationError(failure)
}

function normalizeFailure(error: unknown, fallbackCode: string): VoiceFailure {
  const decoded = Schema.decodeUnknownOption(FailureCarrierSchema)(error)
  if (Option.isSome(decoded)) return decoded.value.failure
  return {
    code: fallbackCode,
    message: error instanceof Error ? error.message : 'Voice operation failed',
    retryable: true,
  }
}

function operationError(failure: VoiceFailure) {
  return new VoiceDirectorOperationError({
    message: failure.message,
    failure,
  })
}

function abortError() {
  return new DOMException('Voice operation superseded', 'AbortError')
}

function isAbortError(error: unknown) {
  return error instanceof DOMException && error.name === 'AbortError'
}

function abortSignal(signal: AbortSignal) {
  return Effect.callback<never, DOMException>((resume) => {
    if (signal.aborted) {
      resume(Effect.fail(abortError()))
      return
    }
    const onAbort = () => resume(Effect.fail(abortError()))
    signal.addEventListener('abort', onAbort, { once: true })
    return Effect.sync(() => signal.removeEventListener('abort', onAbort))
  })
}

function abortableDelay(milliseconds: number, signal: AbortSignal) {
  return Effect.sleep(milliseconds).pipe(Effect.raceFirst(abortSignal(signal)))
}
