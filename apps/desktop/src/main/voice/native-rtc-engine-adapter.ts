import crypto from 'node:crypto'

import {
  Effect,
  Fiber,
  Layer,
  ManagedRuntime,
  Option,
  Schema,
  Semaphore,
} from 'effect'
import type {
  RtcEngineAdapter,
  VoiceDisconnectCause,
  VoiceEngineEvent,
  VoiceLease,
  VoiceMediaDesiredState,
  VoiceMediaKind,
  VoiceMediaSnapshot,
  VoiceRemoteAudioSettings,
} from '@syrnike13/platform'
import { areVoiceMediaDesiredStatesEqual } from '@syrnike13/platform'

import {
  NativeRuntimeErrorSchema,
  type NativeRuntimeCommand,
  type NativeRuntimeDiagnosticContext,
  type NativeRuntimeError,
  type NativeRuntimeEvent,
} from '../native-runtime/contract'
import type {
  NativeRuntimeSupervisor,
  NativeRuntimeSupervisorSnapshot,
} from '../native-runtime/runtime-supervisor'

const VOICE_OPERATION_TIMEOUT_MS = 20_000
const MEDIA_CONTROL_TIMEOUT_MS = 2_000
const OUTPUT_START_TIMEOUT_MS = 5_000
const MICROPHONE_CONFIG_TIMEOUT_MS = 5_000
const SCREEN_RETRY_DELAYS_MS = [750, 1_500, 3_000] as const
const SCREEN_RUNTIME_SETTLE_DELAY_MS = 1_500

const NativeRuntimeErrorCarrierSchema = Schema.Struct({
  detail: NativeRuntimeErrorSchema,
})

const VoiceFailureSchema = Schema.Struct({
  code: Schema.String,
  message: Schema.String,
  retryable: Schema.Boolean,
  stage: Schema.optional(Schema.String),
  hresult: Schema.optional(Schema.Number),
})

class NativeVoiceOperationError extends Schema.ErrorClass<NativeVoiceOperationError>(
  'syrnike13/NativeVoiceOperationError',
)({
  _tag: Schema.tag('NativeVoiceOperationError'),
  message: Schema.String,
  failure: VoiceFailureSchema,
}) {}

function nativeScreenFailureRetryable(code: string | undefined) {
  return code !== 'target_closed' && code !== 'gpu_permission_denied'
}

type NativeVoiceRuntime = Pick<
  NativeRuntimeSupervisor,
  | 'request'
  | 'requestEffect'
  | 'onEvent'
  | 'onStateChange'
  | 'allocateGeneration'
  | 'allocateMicrophoneConfigRevision'
>

type NativeDiagnosticAction = Omit<NativeRuntimeDiagnosticContext, 'hostEpoch'>

type ActiveVoiceConnection = {
  lease: VoiceLease
  voiceGeneration: number
  voiceReady: boolean
  voiceReconnecting: boolean
  microphoneGeneration: number | null
  screenGeneration: number | null
  screenSourceKey: string | null
  cameraGeneration: number | null
  cameraKey: string | null
  outputKey: string | null
  outputMedia: VoiceMediaSnapshot
  microphoneReady: boolean
  appliedMicrophoneMuted: boolean | null
  screenStarted: boolean
  screenRetryAttempt: number
  screenRetryKey: string | null
  cameraStarted: boolean
  selfSpeaking: boolean
  remoteSpeakingUserIds: Set<string>
  speakingUserIds: Set<string>
}

type NativeRtcEngineAdapterOptions = Readonly<{
  screenRetryDelaysMs?: readonly number[]
  screenRuntimeSettleDelayMs?: number
}>

export class NativeRtcEngineAdapter implements RtcEngineAdapter {
  private readonly listeners = new Set<(event: VoiceEngineEvent) => void>()
  private readonly effectRuntime = ManagedRuntime.make(Layer.empty)
  private readonly voiceLifecycleLock = Semaphore.makeUnsafe(1)
  private readonly unsubscribeEvent: () => void
  private readonly unsubscribeState: () => void
  private desired: VoiceMediaDesiredState | null = null
  private active: ActiveVoiceConnection | null = null
  private mediaRevision = 0
  private mediaHandledRevision = 0
  private mediaReconcile: Fiber.Fiber<void, never> | null = null
  private microphoneAppliedConfigRevision = 0
  private microphoneConfigKey: string | null = null
  private microphoneConfigFiber: Fiber.Fiber<void, unknown> | null = null
  private microphoneConfigScheduled = false
  private microphonePipelineWarm = false
  private microphoneWarmFiber: Fiber.Fiber<void, unknown> | null = null
  private runtimeEpoch = 0
  private observedHostEpoch: number | null = null
  private terminalRuntimeLossEpoch: number | null = null
  private runtimeAvailable = true
  private runtimeLost = false
  private runtimeRestartObserved = false
  private availabilityRetryable = true
  private screenRetryWakeToken = 0
  private screenRuntimeWakeToken = 0
  private screenRuntimeSettleUntil = 0
  private disposed = false
  private remoteAudioSettings: VoiceRemoteAudioSettings | null = null
  private diagnosticAction: NativeDiagnosticAction = {
    actionId: `media-action-${crypto.randomUUID()}`,
    revision: 0,
  }

  constructor(
    private readonly runtime: NativeVoiceRuntime,
    private readonly excludeProcessId: () => number = () => process.pid,
    private readonly options: NativeRtcEngineAdapterOptions = {},
  ) {
    this.unsubscribeEvent = runtime.onEvent((event) => this.handleRuntimeEvent(event))
    this.unsubscribeState = runtime.onStateChange((snapshot) =>
      this.handleRuntimeState(snapshot),
    )
  }

  connect(
    lease: VoiceLease,
    desired: VoiceMediaDesiredState,
    signal: AbortSignal,
  ) {
    return this.effectRuntime.runPromise(
      this.voiceLifecycleLock.withPermit(
        this.connectSerializedEffect(lease, desired, signal),
      ),
    )
  }

  private connectSerializedEffect(
    lease: VoiceLease,
    desired: VoiceMediaDesiredState,
    signal: AbortSignal,
  ) {
    return Effect.gen({ self: this }, function*() {
      if (this.disposed) {
        return yield* Effect.fail(
          new Error('Native RTC adapter is disposed'),
        )
      }
      if (lease.rtcEngine !== 'windows_native') {
        return yield* Effect.fail(
          new Error(
            'Native RTC adapter received a non-native Voice Lease',
          ),
        )
      }
      if (signal.aborted) return yield* Effect.fail(abortError())
      if (this.active) {
        yield* this.disconnectSerializedEffect('superseded')
      }
      if (signal.aborted) return yield* Effect.fail(abortError())
      this.beginDiagnosticAction(lease.operationId)
      this.desired = desired
      const generation = this.runtime.allocateGeneration('voice')
      const active: ActiveVoiceConnection = {
        lease,
        voiceGeneration: generation,
        voiceReady: false,
        voiceReconnecting: false,
        microphoneGeneration: null,
        screenGeneration: null,
        screenSourceKey: null,
        cameraGeneration: null,
        cameraKey: null,
        outputKey: null,
        outputMedia: { state: 'starting' },
        microphoneReady: false,
        appliedMicrophoneMuted: null,
        screenStarted: false,
        screenRetryAttempt: 0,
        screenRetryKey: null,
        cameraStarted: false,
        selfSpeaking: false,
        remoteSpeakingUserIds: new Set(),
        speakingUserIds: new Set(),
      }
      this.active = active

      yield* this.requestEffect(
        {
          type: 'connectVoice',
          sessionId: lease.connectionEpoch,
            generation,
            options: { livekit: lease.credential },
          },
          VOICE_OPERATION_TIMEOUT_MS,
      ).pipe(
        Effect.raceFirst(abortSignal(signal)),
        Effect.catch((error) => {
          const cleanup =
            this.active === active
              ? this.disconnectSerializedEffect(
                  isAbortError(error) ? 'superseded' : 'recovery',
                ).pipe(Effect.catch(() => Effect.void))
              : Effect.void
          return cleanup.pipe(
            Effect.andThen(
              Effect.fail(
                isAbortError(error)
                  ? error
                  : voiceFailureError(
                      error,
                      'native_voice_connect_failed',
                    ),
              ),
            ),
          )
        }),
      )
      yield* this.assertCurrentEffect(active)
      if (signal.aborted) {
        yield* this.disconnectSerializedEffect('superseded')
        return yield* Effect.fail(abortError())
      }
      active.voiceReady = true

      yield* this.replayRemoteAudioSettingsEffect(active)
      if (signal.aborted) {
        yield* this.disconnectSerializedEffect('superseded')
        return yield* Effect.fail(abortError())
      }
      yield* this.assertCurrentEffect(active)

      // Membership is independent from track readiness. Track actors reconcile
      // only after the one shared Room is ready and never race their own lane.
      this.requestMediaReconcile()
    })
  }

  disconnect(cause: VoiceDisconnectCause) {
    return this.effectRuntime.runPromise(
      this.voiceLifecycleLock.withPermit(
        this.disconnectSerializedEffect(cause),
      ),
    )
  }

  private disconnectSerializedEffect(_cause: VoiceDisconnectCause) {
    return Effect.gen({ self: this }, function*() {
      const active = this.active
      this.active = null
      this.screenRetryWakeToken += 1
      this.mediaRevision += 1
      if (!active) return
      this.beginDiagnosticAction(active.lease.operationId)
      active.selfSpeaking = false
      active.remoteSpeakingUserIds.clear()
      active.speakingUserIds.clear()
      if (this.runtimeLost) return

      yield* Effect.all(
        [
          active.microphoneGeneration !== null
            ? this.requestEffect(
                  {
                    type: 'disconnectMicrophone',
                    sessionId: active.lease.connectionEpoch,
                    generation: this.runtime.allocateGeneration('microphone'),
                  },
                  MEDIA_CONTROL_TIMEOUT_MS,
                ).pipe(Effect.ignore)
            : Effect.void,
          this.requestEffect(
              {
                type: 'disconnectScreen',
                sessionId: active.lease.connectionEpoch,
                generation: this.runtime.allocateGeneration('screen'),
              },
              MEDIA_CONTROL_TIMEOUT_MS,
            ).pipe(Effect.ignore),
          active.cameraStarted
            ? this.requestEffect(
                  {
                    type: 'disconnectCamera',
                    sessionId: active.lease.connectionEpoch,
                    generation: this.runtime.allocateGeneration('camera'),
                  },
                  MEDIA_CONTROL_TIMEOUT_MS,
                ).pipe(Effect.ignore)
            : Effect.void,
        ],
        { concurrency: 'unbounded' },
      )
      yield* this.requestEffect(
        {
          type: 'disconnectVoice',
          sessionId: active.lease.connectionEpoch,
          generation: this.runtime.allocateGeneration('voice'),
        },
        MEDIA_CONTROL_TIMEOUT_MS,
      )
    })
  }

  updateDesiredMedia(desired: VoiceMediaDesiredState) {
    if (this.desired && areVoiceMediaDesiredStatesEqual(this.desired, desired)) return
    const previousScreenKey = this.desired
      ? screenSourceKey(this.desired)
      : null
    this.desired = desired
    const active = this.active
    if (active && previousScreenKey !== screenSourceKey(desired)) {
      this.resetScreenRetry(active)
    }
    this.beginDiagnosticAction(active?.lease.operationId)
    if (!active || !active.voiceReady) {
      this.scheduleMicrophoneConfiguration()
      return
    }
    this.requestMediaReconcile()
  }

  updateRemoteAudioSettings(settings: VoiceRemoteAudioSettings) {
    if (
      this.remoteAudioSettings &&
      settings.revision <= this.remoteAudioSettings.revision
    ) return
    this.remoteAudioSettings = settings
    const active = this.active
    this.beginDiagnosticAction(active?.lease.operationId, settings.revision)
    if (active?.voiceReady) {
      this.effectRuntime.runFork(
        this.replayRemoteAudioSettingsEffect(active),
      )
    }
  }

  retryMedia(kind: VoiceMediaKind) {
    const active = this.active
    const desired = this.desired
    if (!active || !desired) return
    if (kind === 'microphone') {
      active.appliedMicrophoneMuted = null
      this.requestMediaReconcile()
      return
    }
    if (kind === 'screen' || kind === 'screen_audio') {
      active.screenStarted = false
      active.screenSourceKey = null
      this.resetScreenRetry(active)
      this.requestMediaReconcile()
      return
    }
    if (kind === 'camera') {
      active.cameraStarted = false
      active.cameraKey = null
      this.requestMediaReconcile()
      return
    }
    if (kind === 'output') {
      active.outputKey = null
      if (active.voiceReady) {
        this.effectRuntime.runFork(
          this.replayRemoteAudioSettingsEffect(active),
        )
      }
      this.requestMediaReconcile()
    }
  }

  subscribe(listener: (event: VoiceEngineEvent) => void) {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  prewarmMicrophone() {
    return this.effectRuntime.runPromise(this.prewarmMicrophoneEffect())
  }

  prewarmMicrophoneEffect() {
    return Effect.suspend(() =>
      this.disposed
        ? Effect.fail(new Error('Native RTC adapter is disposed'))
        : this.ensureMicrophonePipelineWarmEffect(),
    )
  }

  dispose() {
    if (this.disposed) return
    this.disposed = true
    this.unsubscribeEvent()
    this.unsubscribeState()
    this.listeners.clear()
    Effect.runFork(this.effectRuntime.disposeEffect)
  }

  private scheduleMicrophoneConfiguration() {
    if (this.microphoneConfigScheduled) return
    this.microphoneConfigScheduled = true
    queueMicrotask(() => {
      this.microphoneConfigScheduled = false
      if (this.disposed) return
      this.effectRuntime.runFork(
        this.ensureMicrophoneConfigurationEffect().pipe(Effect.ignore),
      )
    })
  }

  private replayRemoteAudioSettingsEffect(active: ActiveVoiceConnection) {
    return Effect.gen({ self: this }, function*() {
      const settings = this.remoteAudioSettings
      if (!settings) return
      yield* this.requestEffect(
        {
          type: 'configureRemoteAudio',
          sessionId: active.lease.connectionEpoch,
          generation: active.voiceGeneration,
          settings,
        },
        MEDIA_CONTROL_TIMEOUT_MS,
      ).pipe(
        Effect.flatMap(() => this.assertCurrentEffect(active)),
        Effect.catch((error) =>
          Effect.sync(() => {
            if (this.active === active) {
              this.emitMediaFailure(
                active,
                'output',
                error,
                'remote_audio_config_failed',
              )
            }
          }),
        ),
      )
    })
  }

  private ensureMicrophoneConfigurationEffect() {
    return Effect.gen({ self: this }, function*() {
      while (this.desired) {
        const desired = this.desired
        const config = microphoneConfig(desired)
        const key = JSON.stringify(config)
        if (this.microphoneConfigKey === key) return
        if (this.microphoneConfigFiber) {
          yield* Fiber.join(this.microphoneConfigFiber)
          continue
        }

        const revision = this.runtime.allocateMicrophoneConfigRevision()
        const runtimeEpoch = this.runtimeEpoch
        let fiber: Fiber.Fiber<void, unknown>
        const operation = this.requestEffect(
          {
            type: 'configureMicrophone',
            revision,
            config,
          },
          MICROPHONE_CONFIG_TIMEOUT_MS,
        ).pipe(
          Effect.tap(() =>
            Effect.sync(() => {
              if (runtimeEpoch === this.runtimeEpoch) {
                this.microphoneConfigKey = key
                this.microphoneAppliedConfigRevision = revision
              }
            }),
          ),
          Effect.tapError((error) =>
            Effect.sync(() => {
              this.microphoneConfigKey = null
              const active = this.active
              if (active) {
                this.emitMediaFailure(
                  active,
                  'microphone',
                  error,
                  'microphone_config_failed',
                )
              }
            }),
          ),
          Effect.asVoid,
          Effect.ensuring(
            Effect.sync(() => {
              if (this.microphoneConfigFiber === fiber) {
                this.microphoneConfigFiber = null
              }
            }),
          ),
        )
        fiber = this.effectRuntime.runFork(operation)
        this.microphoneConfigFiber = fiber
        yield* Fiber.join(fiber)
      }
    })
  }

  private ensureMicrophoneEffect(
    active: ActiveVoiceConnection,
    desired: VoiceMediaDesiredState,
  ) {
    return Effect.gen({ self: this }, function*() {
      if (active !== this.active || active.microphoneReady) return
      yield* this.ensureMicrophonePipelineWarmEffect()
      yield* this.assertCurrentEffect(active)
      const generation = this.runtime.allocateGeneration('microphone')
      active.microphoneGeneration = generation
      this.emitMedia(active, 'microphone', { state: 'starting' })
      yield* this.requestEffect(
        {
          type: 'connectMicrophone',
          sessionId: active.lease.connectionEpoch,
          generation,
          excludeProcessId: this.excludeProcessId(),
          options: {
            kind: 'microphone',
            requestId: `microphone-${active.lease.connectionEpoch}`,
            participantIdentity: active.lease.credential.participantIdentity,
            muted: desired.effectiveMuted,
          },
        },
        VOICE_OPERATION_TIMEOUT_MS,
      ).pipe(
        Effect.flatMap(() =>
          Effect.sync(() => {
            this.assertCurrent(active)
            if (active.microphoneGeneration !== generation) return
            active.microphoneReady = true
            active.appliedMicrophoneMuted = desired.effectiveMuted
            this.updateSelfSpeaking(active, false)
            this.emitMedia(active, 'microphone', {
              state: desired.effectiveMuted ? 'muted' : 'running',
            })
          }),
        ),
        Effect.catch((error) =>
          Effect.sync(() => {
            if (
              active !== this.active ||
              active.microphoneGeneration !== generation
            ) return
            this.retireMediaKind(active, 'microphone')
            this.emitMediaFailure(
              active,
              'microphone',
              error,
              'microphone_start_failed',
            )
          }),
        ),
      )
    })
  }

  private ensureMicrophonePipelineWarmEffect() {
    return Effect.gen({ self: this }, function*() {
      if (this.microphonePipelineWarm) return
      if (this.microphoneWarmFiber) {
        yield* Fiber.join(this.microphoneWarmFiber)
        return
      }
      let fiber: Fiber.Fiber<void, unknown>
      const operation = Effect.gen({ self: this }, function*() {
        yield* this.ensureMicrophoneConfigurationEffect()
        const desired = this.desired
        if (!desired) return
        const runtimeEpoch = this.runtimeEpoch
        yield* this.requestEffect(
          {
            type: 'warmMicrophone',
            generation: this.runtime.allocateGeneration('microphone'),
            config: microphoneConfig(desired),
          },
          VOICE_OPERATION_TIMEOUT_MS,
        )
        if (runtimeEpoch === this.runtimeEpoch) {
          this.microphonePipelineWarm = true
        }
      }).pipe(
        Effect.ensuring(
          Effect.sync(() => {
            if (this.microphoneWarmFiber === fiber) {
              this.microphoneWarmFiber = null
            }
          }),
        ),
      )
      fiber = this.effectRuntime.runFork(operation)
      this.microphoneWarmFiber = fiber
      yield* Fiber.join(fiber)
    })
  }

  private beginDiagnosticAction(
    operationId = this.active?.lease.operationId,
    revision = this.mediaRevision,
  ) {
    this.diagnosticAction = {
      actionId: `media-action-${crypto.randomUUID()}`,
      operationId,
      revision,
    }
  }

  private requestEffect(
    command: NativeRuntimeCommand,
    timeoutMs: number,
  ) {
    return this.runtime.requestEffect(command, timeoutMs, {
      diagnostic: this.diagnosticAction,
    })
  }

  private requestMediaReconcile() {
    this.mediaRevision += 1
    this.beginDiagnosticAction(this.active?.lease.operationId)
    this.ensureMediaReconcile()
  }

  private resetScreenRetry(active: ActiveVoiceConnection) {
    this.screenRetryWakeToken += 1
    active.screenRetryAttempt = 0
    active.screenRetryKey = null
  }

  private scheduleScreenRetry(
    active: ActiveVoiceConnection,
    sourceKey: string,
    retryable: boolean,
  ) {
    if (!retryable || this.active !== active) return
    const delays = this.options.screenRetryDelaysMs ?? SCREEN_RETRY_DELAYS_MS
    const delayMs = delays[active.screenRetryAttempt]
    active.screenRetryKey = sourceKey
    if (delayMs === undefined) return
    active.screenRetryAttempt += 1
    const token = ++this.screenRetryWakeToken
    this.effectRuntime.runFork(
      Effect.sleep(delayMs).pipe(
        Effect.andThen(
          Effect.sync(() => {
            if (
              token !== this.screenRetryWakeToken ||
              this.active !== active ||
              active.screenRetryKey !== sourceKey ||
              screenSourceKey(this.desired) !== sourceKey
            ) {
              return
            }
            active.screenRetryKey = null
            this.requestMediaReconcile()
          }),
        ),
      ),
    )
  }

  private scheduleScreenRuntimeWake(delayMs: number) {
    const token = ++this.screenRuntimeWakeToken
    this.effectRuntime.runFork(
      Effect.sleep(delayMs).pipe(
        Effect.andThen(
          Effect.sync(() => {
            if (token !== this.screenRuntimeWakeToken) return
            this.requestMediaReconcile()
          }),
        ),
      ),
    )
  }

  private ensureMediaReconcile() {
    if (
      this.mediaReconcile ||
      !this.active?.voiceReady ||
      !this.desired
    ) {
      return
    }
    let fiber: Fiber.Fiber<void, never>
    const effect = this.reconcileMediaLoopEffect().pipe(
      Effect.ignore,
      Effect.ensuring(
        Effect.sync(() => {
          if (this.mediaReconcile === fiber) this.mediaReconcile = null
          if (
            this.active &&
            this.desired &&
            this.mediaHandledRevision !== this.mediaRevision
          ) {
            this.ensureMediaReconcile()
          }
        }),
      ),
    )
    fiber = this.effectRuntime.runFork(effect)
    this.mediaReconcile = fiber
  }

  private reconcileMediaLoopEffect() {
    return Effect.gen({ self: this }, function*() {
      let handledRevision = -1
      while (
        this.active &&
        this.desired &&
        handledRevision !== this.mediaRevision
      ) {
        handledRevision = this.mediaRevision
        const active = this.active
        const desired = this.desired
        yield* Effect.all(
          [
            this.reconcileMicrophoneEffect(active).pipe(Effect.ignore),
            this.applyScreenEffect(active, desired).pipe(Effect.ignore),
            this.applyCameraEffect(active, desired).pipe(Effect.ignore),
            this.applyOutputEffect(active, desired).pipe(Effect.ignore),
          ],
          { concurrency: 'unbounded' },
        )
        this.mediaHandledRevision = handledRevision
      }
    })
  }

  private reconcileMicrophoneEffect(active: ActiveVoiceConnection) {
    return Effect.gen({ self: this }, function*() {
      yield* this.ensureMicrophoneConfigurationEffect()
      yield* this.assertCurrentEffect(active)
      const desiredBeforeStart = this.desired
      if (!desiredBeforeStart) return
      yield* this.ensureMicrophoneEffect(active, desiredBeforeStart)
      yield* this.assertCurrentEffect(active)
      const desired = this.desired
      const generation = active.microphoneGeneration
      if (
        !desired ||
        !active.microphoneReady ||
        generation === null ||
        active.appliedMicrophoneMuted === desired.effectiveMuted
      ) {
        return
      }
      yield* this.requestEffect(
        {
          type: 'setMicrophoneMuted',
          sessionId: active.lease.connectionEpoch,
          generation,
          muted: desired.effectiveMuted,
        },
        MEDIA_CONTROL_TIMEOUT_MS,
      ).pipe(
        Effect.flatMap(() =>
          Effect.sync(() => {
            this.assertCurrent(active)
            if (
              !active.microphoneReady ||
              active.microphoneGeneration !== generation
            ) return
            active.appliedMicrophoneMuted = desired.effectiveMuted
            this.updateSelfSpeaking(active, false)
            this.emitMedia(active, 'microphone', {
              state: desired.effectiveMuted ? 'muted' : 'running',
            })
          }),
        ),
        Effect.catch((error) =>
          Effect.sync(() => {
            if (
              this.active !== active ||
              !active.microphoneReady ||
              active.microphoneGeneration !== generation
            ) return
            active.appliedMicrophoneMuted = null
            this.emitMediaFailure(
              active,
              'microphone',
              error,
              'microphone_mute_failed',
            )
          }),
        ),
      )
    })
  }

  private applyCameraEffect(
    active: ActiveVoiceConnection,
    desired: VoiceMediaDesiredState,
  ) {
    return Effect.gen({ self: this }, function*() {
      const cameraKey = desired.cameraEnabled
        ? `${desired.cameraDeviceId ?? ''}|1280|720|30`
        : null
      if (!desired.cameraEnabled) {
        if (!active.cameraStarted) return
        active.cameraStarted = false
        active.cameraKey = null
        active.cameraGeneration = null
        yield* this.requestEffect(
          {
            type: 'disconnectCamera',
            sessionId: active.lease.connectionEpoch,
            generation: this.runtime.allocateGeneration('camera'),
          },
          MEDIA_CONTROL_TIMEOUT_MS,
        )
        this.emitMedia(active, 'camera', { state: 'off' })
        return
      }
      if (active.cameraStarted && active.cameraKey === cameraKey) return
      if (active.cameraStarted) {
        yield* this.requestEffect(
          {
            type: 'disconnectCamera',
            sessionId: active.lease.connectionEpoch,
            generation: this.runtime.allocateGeneration('camera'),
          },
          MEDIA_CONTROL_TIMEOUT_MS,
        )
      }
      const generation = this.runtime.allocateGeneration('camera')
      active.cameraStarted = true
      active.cameraGeneration = generation
      active.cameraKey = cameraKey
      this.emitMedia(active, 'camera', { state: 'starting' })
      yield* this.requestEffect(
        {
          type: 'connectCamera',
          sessionId: active.lease.connectionEpoch,
          generation,
          options: {
            deviceId: desired.cameraDeviceId,
            width: 1_280,
            height: 720,
            fps: 30,
            bitrate: 3_000_000,
            participantIdentity: active.lease.credential.participantIdentity,
          },
        },
        VOICE_OPERATION_TIMEOUT_MS,
      ).pipe(
        Effect.flatMap(() => this.assertCurrentEffect(active)),
        Effect.tap(() =>
          Effect.sync(() => {
            if (active.cameraGeneration !== generation) return
            this.emitMedia(active, 'camera', { state: 'running' })
          }),
        ),
        Effect.catch((error) =>
          Effect.sync(() => {
            if (
              this.active !== active ||
              active.cameraGeneration !== generation
            ) return
            this.retireMediaKind(active, 'camera')
            this.emitMediaFailure(
              active,
              'camera',
              error,
              'camera_start_failed',
            )
          }),
        ),
      )
    })
  }

  private applyOutputEffect(
    active: ActiveVoiceConnection,
    desired: VoiceMediaDesiredState,
  ) {
    return Effect.gen({ self: this }, function*() {
      const deafened = desired.userDeafened || desired.serverDeafened
      const volume = desired.outputVolume
      const outputKey =
        `${deafened}|${desired.outputDeviceId ?? ''}|${volume}`
      if (active.outputKey === outputKey) return
      const previousOutputKey = active.outputKey
      const previousOutputMedia = active.outputMedia
      active.outputKey = outputKey
      yield* this.requestEffect(
        {
          type: 'configureVoiceOutput',
          sessionId: active.lease.connectionEpoch,
          generation: active.voiceGeneration,
          deafened,
          deviceId: desired.outputDeviceId,
          volume,
        },
        OUTPUT_START_TIMEOUT_MS,
      ).pipe(
        Effect.flatMap(() => this.assertCurrentEffect(active)),
        Effect.tap(() =>
          Effect.sync(() => {
            if (active.outputKey !== outputKey) return
            this.emitMedia(active, 'output', {
              state: deafened ? 'muted' : 'running',
            })
          }),
        ),
        Effect.catch((error) =>
          Effect.sync(() => {
            if (this.active !== active || active.outputKey !== outputKey) {
              return
            }
            const detail = errorDetail(error)
            if (
              previousOutputKey !== null &&
              detail?.code !== 'audio_output_rollback_failed'
            ) {
              active.outputKey = previousOutputKey
              this.emitMedia(active, 'output', {
                state: previousOutputMedia.state,
                error: {
                  code:
                    detail?.code ?? 'output_config_rolled_back',
                  message:
                    detail?.message ??
                    (error instanceof Error
                      ? error.message
                      : 'Output configuration failed; previous output remains active'),
                  retryable: detail?.retryable ?? true,
                  ...(detail?.stage === undefined
                    ? {}
                    : { stage: detail.stage }),
                  ...(detail?.hresult === undefined
                    ? {}
                    : { hresult: detail.hresult }),
                },
              })
              return
            }
            this.retireMediaKind(active, 'output')
            this.emitMediaFailure(
              active,
              'output',
              error,
              'output_config_failed',
            )
          }),
        ),
      )
    })
  }

  private applyScreenEffect(
    active: ActiveVoiceConnection,
    desired: VoiceMediaDesiredState,
  ) {
    return Effect.gen({ self: this }, function*() {
      const sourceKey = screenSourceKey(desired)
      if (!desired.screenEnabled || !desired.screenSourceId) {
        this.resetScreenRetry(active)
        if (!active.screenStarted) return
        const generation = this.runtime.allocateGeneration('screen')
        active.screenStarted = false
        active.screenGeneration = null
        active.screenSourceKey = null
        yield* this.requestEffect(
          {
            type: 'disconnectScreen',
            sessionId: active.lease.connectionEpoch,
            generation,
          },
          MEDIA_CONTROL_TIMEOUT_MS,
        )
        this.emitMedia(active, 'screen', { state: 'off' })
        this.emitMedia(active, 'screen_audio', { state: 'off' })
        return
      }
      const screenSourceId = desired.screenSourceId
      if (active.screenStarted && active.screenSourceKey === sourceKey) {
        return
      }
      if (active.voiceReconnecting || sourceKey === null) return
      const runtimeSettleDelay = this.screenRuntimeSettleUntil - Date.now()
      if (runtimeSettleDelay > 0) {
        this.scheduleScreenRuntimeWake(runtimeSettleDelay)
        return
      }
      if (active.screenRetryKey === sourceKey) return
      if (active.screenStarted) {
        yield* this.requestEffect(
          {
            type: 'disconnectScreen',
            sessionId: active.lease.connectionEpoch,
            generation: this.runtime.allocateGeneration('screen'),
          },
          MEDIA_CONTROL_TIMEOUT_MS,
        )
      }

      const generation = this.runtime.allocateGeneration('screen')
      active.screenGeneration = generation
      active.screenStarted = true
      active.screenSourceKey = sourceKey
      this.emitMedia(active, 'screen', { state: 'starting' })
      yield* Effect.gen({ self: this }, function*() {
        yield* this.requestEffect(
          {
            type: 'connectScreen',
            sessionId: active.lease.connectionEpoch,
            generation,
            options: {
              participantIdentity:
                active.lease.credential.participantIdentity,
            },
          },
          VOICE_OPERATION_TIMEOUT_MS,
        )
        yield* this.assertCurrentEffect(active)
        if (active.screenGeneration !== generation) return
        yield* this.requestEffect(
          {
            type: 'startScreenCapture',
            sessionId: active.lease.connectionEpoch,
            generation,
            excludeProcessId: this.excludeProcessId(),
            options: {
              kind: 'screen',
              requestId: `screen-${active.lease.connectionEpoch}`,
              sourceId: screenSourceId,
              width: desired.screenWidth ?? 1_920,
              height: desired.screenHeight ?? 1_080,
              fps: desired.screenFps ?? 30,
              bitrate: desired.screenBitrate ?? 6_000_000,
              audioBitrate: desired.screenAudioBitrate ?? 128_000,
              audio: { requested: desired.screenAudioEnabled },
              participantIdentity:
                active.lease.credential.participantIdentity,
            },
          },
          VOICE_OPERATION_TIMEOUT_MS,
        )
        yield* this.assertCurrentEffect(active)
        if (active.screenGeneration !== generation) return
        this.resetScreenRetry(active)
        this.emitMedia(active, 'screen', { state: 'running' })
        this.emitMedia(active, 'screen_audio', {
          state: desired.screenAudioEnabled ? 'running' : 'off',
        })
      }).pipe(
        Effect.catch((error) =>
          Effect.sync(() => {
            if (
              this.active !== active ||
              active.screenGeneration !== generation
            ) return
            const detail = errorDetail(error)
            const retryable =
              detail?.retryable ??
              nativeScreenFailureRetryable(detail?.code)
            this.retireMediaKind(active, 'screen')
            this.scheduleScreenRetry(active, sourceKey, retryable)
            this.emitMediaFailure(
              active,
              'screen',
              error,
              'screen_start_failed',
            )
          }),
        ),
      )
    })
  }

  private handleRuntimeEvent(event: NativeRuntimeEvent) {
    const active = this.active
    if (!active) return
    if (
      'sessionId' in event &&
      event.sessionId !== undefined &&
      event.sessionId !== active.lease.connectionEpoch
    ) {
      return
    }
    if (event.type === 'voiceConnectionState') {
      if (event.generation !== active.voiceGeneration) return
      if (event.state === 'reconnecting') {
        if (active.voiceReconnecting) return
        active.voiceReconnecting = true
        this.emit({
          type: 'transientReconnectStarted',
          operationId: active.lease.operationId,
          connectionEpoch: active.lease.connectionEpoch,
        })
        return
      }
      const recovered = active.voiceReconnecting
      active.voiceReconnecting = false
      if (!recovered) return
      this.emit({
        type: 'transientReconnectSucceeded',
        operationId: active.lease.operationId,
        connectionEpoch: active.lease.connectionEpoch,
      })
      this.requestMediaReconcile()
      return
    }
    if (event.type === 'voiceTerminal') {
      if (event.generation !== active.voiceGeneration) return
      this.emit({
        type: 'terminalFailure',
        operationId: active.lease.operationId,
        connectionEpoch: active.lease.connectionEpoch,
        failure: {
          code: event.error.code,
          message: event.error.message,
          retryable: event.error.retryable,
          stage: event.error.stage,
          ...(event.error.hresult === undefined
            ? {}
            : { hresult: event.error.hresult }),
        },
      })
      return
    }
    if (event.type === 'cameraTerminal') {
      if (
        active.cameraGeneration === null ||
        event.generation !== active.cameraGeneration
      ) return
      this.retireMediaKind(active, 'camera')
      this.emitMedia(active, 'camera', {
        state: 'failed',
        error: {
          code: event.error.code,
          message: event.error.message,
          retryable: event.error.retryable,
          stage: event.error.stage,
          ...(event.error.hresult === undefined
            ? {}
            : { hresult: event.error.hresult }),
        },
      })
      return
    }
    if (event.type === 'screenCaptureEnded') {
      if (
        active.screenGeneration === null ||
        event.generation !== active.screenGeneration
      ) return
      this.retireMediaKind(active, 'screen')
      const targetClosed = event.reason === 'target_closed'
      const error = {
        code: targetClosed
          ? 'screen_capture_target_closed'
          : `screen_${event.reason || 'capture_failed'}`,
        message: targetClosed
          ? 'Источник демонстрации больше недоступен'
          : (event.message ?? 'Native screen capture stopped unexpectedly'),
        retryable: nativeScreenFailureRetryable(event.reason),
        stage: 'screen_capture',
      }
      this.emitMedia(active, 'screen', { state: 'failed', error })
      if (this.desired?.screenAudioEnabled) {
        this.emitMedia(active, 'screen_audio', { state: 'failed', error })
      }
      const sourceKey = screenSourceKey(this.desired)
      if (sourceKey) {
        this.scheduleScreenRetry(active, sourceKey, error.retryable)
      }
      return
    }
    if (event.type === 'activeSpeakers') {
      if (event.generation !== active.voiceGeneration) return
      active.remoteSpeakingUserIds = new Set(
        event.participantIdentities.map(normalizeSpeakingIdentity),
      )
      this.emitSpeaking(active)
      return
    }
    if (event.type === 'microphoneMetrics') {
      if (event.metrics.revision !== this.microphoneAppliedConfigRevision) return
      if (!active.voiceReady || !active.microphoneReady) return
      const desired = this.desired
      this.updateSelfSpeaking(
        active,
        Boolean(
          event.metrics.open &&
          desired &&
          !desired.effectiveMuted &&
          active.appliedMicrophoneMuted === false,
        ),
      )
      return
    }
    if (event.type === 'sessionLifecycle') {
      const kind = event.kind
      if (
        kind !== 'microphone' &&
        kind !== 'screen' &&
        kind !== 'camera' &&
        kind !== 'output'
      ) {
        return
      }
      const expectedGeneration =
        kind === 'microphone'
          ? active.microphoneGeneration
          : kind === 'screen'
            ? active.screenGeneration
            : kind === 'camera'
              ? active.cameraGeneration
              : active.voiceGeneration
      if (
        expectedGeneration === null ||
        event.generation !== expectedGeneration ||
        (kind === 'output' && active.outputKey === null)
      ) return
      if (event.state.status === 'error') {
        const failure = event.error
        this.retireMediaKind(active, kind)
        const mediaFailure = {
          state: 'failed',
          error: {
            code: failure?.code ?? `${kind}_runtime_failed`,
            message: failure?.message ?? event.state.message ?? `${kind} runtime failed`,
            retryable: failure?.retryable ?? true,
            ...(failure?.stage === undefined ? {} : { stage: failure.stage }),
            ...(failure?.hresult === undefined ? {} : { hresult: failure.hresult }),
          },
        } as const
        this.emitMedia(active, kind, mediaFailure)
        if (kind === 'screen' && this.desired?.screenAudioEnabled) {
          this.emitMedia(active, 'screen_audio', mediaFailure)
        }
        const sourceKey = kind === 'screen'
          ? screenSourceKey(this.desired)
          : null
        if (sourceKey) {
          this.scheduleScreenRetry(
            active,
            sourceKey,
            mediaFailure.error.retryable,
          )
        }
      } else if (
        (kind === 'microphone' || kind === 'output') &&
        event.state.status === 'starting' &&
        event.error
      ) {
        if (kind === 'microphone') this.updateSelfSpeaking(active, false)
        this.emitMedia(active, kind, {
          state: 'starting',
          error: {
            code: event.error.code,
            message: event.error.message,
            retryable: event.error.retryable,
            ...(event.error.stage === undefined ? {} : { stage: event.error.stage }),
            ...(event.error.hresult === undefined
              ? {}
              : { hresult: event.error.hresult }),
          },
        })
      } else if (
        (kind === 'microphone' || kind === 'output') &&
        event.state.status === 'running' &&
        event.state.deviceId === 'default' &&
        event.error?.code ===
          (kind === 'microphone'
            ? 'audio_input_fallback_default'
            : 'audio_output_fallback_default')
      ) {
        if (kind === 'microphone') {
          // The native lifecycle event remains in local diagnostics, but a
          // working default microphone is not a media failure and must not
          // trigger an automatic diagnostic upload.
          this.emitMedia(active, kind, { state: 'running' })
        } else {
          this.emitMedia(active, kind, {
            state: 'running',
            error: {
              code: 'output_device_fallback',
              message: event.error.message,
              retryable: false,
            },
          })
        }
      } else if (
        (kind === 'microphone' || kind === 'output') &&
        event.state.status === 'running' &&
        (
          event.state.message ===
            (kind === 'microphone'
              ? 'audio_input_default_recovered'
              : 'audio_output_default_recovered') ||
          (kind === 'output' &&
            event.state.message === 'audio_output_recovered')
        )
      ) {
        this.emitMedia(active, kind, {
          state:
            kind === 'microphone' && this.desired?.effectiveMuted
              ? 'muted'
              : 'running',
        })
      }
    }
  }

  private retireMediaKind(
    active: ActiveVoiceConnection,
    kind: 'microphone' | 'screen' | 'camera' | 'output',
  ) {
    if (kind === 'microphone') {
      active.microphoneReady = false
      active.microphoneGeneration = null
      active.appliedMicrophoneMuted = null
      this.updateSelfSpeaking(active, false)
      return
    }
    if (kind === 'screen') {
      active.screenStarted = false
      active.screenGeneration = null
      active.screenSourceKey = null
      return
    }
    if (kind === 'camera') {
      active.cameraStarted = false
      active.cameraGeneration = null
      active.cameraKey = null
      return
    }
    active.outputKey = null
  }

  private handleRuntimeState(snapshot: NativeRuntimeSupervisorSnapshot) {
    const wasRuntimeLost = this.runtimeLost
    const hostEpoch = snapshot.hostEpoch
    if (hostEpoch !== undefined && hostEpoch !== this.observedHostEpoch) {
      this.observedHostEpoch = hostEpoch
      this.runtimeEpoch += 1
      this.microphoneConfigKey = null
      this.microphonePipelineWarm = false
      this.microphoneAppliedConfigRevision = 0
    }
    const available = snapshot.status === 'ready'
    this.runtimeLost =
      snapshot.status === 'recovering' ||
      snapshot.status === 'degraded' ||
      snapshot.status === 'stopped'
    if (this.runtimeLost) this.runtimeRestartObserved = true
    if (available && (wasRuntimeLost || this.runtimeRestartObserved)) {
      const settleDelay =
        this.options.screenRuntimeSettleDelayMs ??
        SCREEN_RUNTIME_SETTLE_DELAY_MS
      this.runtimeRestartObserved = false
      this.screenRuntimeSettleUntil = Date.now() + settleDelay
      if (settleDelay > 0) this.scheduleScreenRuntimeWake(settleDelay)
    }
    const retryable = snapshot.failure?.retryable ?? snapshot.status !== 'degraded'
    const runtimeFailure = available
      ? undefined
      : {
          code: snapshot.status === 'degraded' ? 'runtime_degraded' : 'runtime_lost',
          message:
            snapshot.failure?.message ??
            snapshot.degradedReason ??
            snapshot.lastFailure ??
            'Native media runtime is unavailable',
          retryable,
          stage: 'native_runtime',
        }
    if (
      available !== this.runtimeAvailable ||
      retryable !== this.availabilityRetryable
    ) {
      this.runtimeAvailable = available
      this.availabilityRetryable = retryable
      this.emit({
        type: 'availabilityChanged',
        available,
        retryable,
        failure: runtimeFailure,
      })
    }
    const active = this.active
    if (!active) return
    if (snapshot.status !== 'recovering' && snapshot.status !== 'degraded') return
    if (hostEpoch === undefined || this.terminalRuntimeLossEpoch === hostEpoch) return
    this.terminalRuntimeLossEpoch = hostEpoch
    this.emit({
      type: 'terminalFailure',
      operationId: active.lease.operationId,
      connectionEpoch: active.lease.connectionEpoch,
      failure: runtimeFailure!,
    })
  }

  private emitMedia(
    active: ActiveVoiceConnection,
    kind: VoiceMediaKind,
    media: VoiceMediaSnapshot,
  ) {
    if (kind === 'output') active.outputMedia = media
    this.emit({
      type: 'mediaState',
      kind,
      media,
      operationId: active.lease.operationId,
      connectionEpoch: active.lease.connectionEpoch,
    })
  }

  private emitMediaFailure(
    active: ActiveVoiceConnection,
    kind: VoiceMediaKind,
    error: unknown,
    code: string,
  ) {
    const detail = errorDetail(error)
    const nativeCode = detail?.code
    this.emitMedia(active, kind, {
      state: 'failed',
      error: {
        code: kind === 'screen' && nativeCode === 'target_closed'
          ? 'screen_capture_target_closed'
          : kind === 'screen' && nativeCode?.startsWith('gpu_')
            ? `screen_${nativeCode}`
            : code,
        message:
          kind === 'screen' && nativeCode === 'target_closed'
            ? 'Источник демонстрации больше недоступен'
            : error instanceof Error
              ? (detail?.message ?? error.message)
              : `${kind} failed`,
        retryable:
          detail?.retryable ?? nativeScreenFailureRetryable(nativeCode),
        ...(detail?.stage === undefined ? {} : { stage: detail.stage }),
        ...(detail?.hresult === undefined ? {} : { hresult: detail.hresult }),
      },
    })
  }

  private emit(event: VoiceEngineEvent) {
    for (const listener of this.listeners) listener(event)
  }

  private updateSelfSpeaking(active: ActiveVoiceConnection, speaking: boolean) {
    if (active.selfSpeaking === speaking) return
    active.selfSpeaking = speaking
    this.emitSpeaking(active)
  }

  private emitSpeaking(active: ActiveVoiceConnection) {
    const next = new Set(active.remoteSpeakingUserIds)
    if (active.selfSpeaking) {
      next.add(normalizeSpeakingIdentity(active.lease.credential.participantIdentity))
    }
    if (sameStringSet(active.speakingUserIds, next)) return
    active.speakingUserIds = next
    this.emit({
      type: 'speakingChanged',
      participantIdentities: [...next],
      operationId: active.lease.operationId,
      connectionEpoch: active.lease.connectionEpoch,
    })
  }

  private assertCurrent(active: ActiveVoiceConnection) {
    if (this.active !== active) throw abortError()
  }

  private assertCurrentEffect(active: ActiveVoiceConnection) {
    return Effect.try({
      try: () => this.assertCurrent(active),
      catch: (cause) => cause,
    })
  }
}

function microphoneConfig(desired: VoiceMediaDesiredState) {
  return {
    deviceId: desired.microphoneDeviceId ?? null,
    bypassSystemAudioInputProcessing:
      desired.bypassSystemAudioInputProcessing,
    automaticGainControl: desired.automaticGainControl,
    noiseSuppression: desired.noiseSuppression,
    echoCancellation: desired.echoCancellation,
    inputVolume: desired.inputVolume,
    voiceGateEnabled: desired.voiceGateEnabled,
    voiceGateThresholdDb: desired.voiceGateThresholdDb,
    voiceGateAutoThreshold: desired.voiceGateAutoThreshold,
  }
}

function screenSourceKey(desired: VoiceMediaDesiredState | null) {
  if (!desired?.screenEnabled) return null
  return [
    desired.screenSourceId,
    desired.screenAudioEnabled,
    desired.screenWidth,
    desired.screenHeight,
    desired.screenFps,
    desired.screenBitrate,
    desired.screenAudioBitrate,
  ].join('|')
}

function normalizeSpeakingIdentity(identity: string) {
  const parts = identity.split('|')
  return parts.length === 6 && parts[0] === 'voice:v1'
    ? parts[5] ?? identity
    : identity
}

function sameStringSet(left: ReadonlySet<string>, right: ReadonlySet<string>) {
  if (left.size !== right.size) return false
  for (const value of left) {
    if (!right.has(value)) return false
  }
  return true
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

function abortError() {
  return new DOMException('Native RTC operation superseded', 'AbortError')
}

function isAbortError(error: unknown) {
  return error instanceof DOMException && error.name === 'AbortError'
}

function voiceFailureError(error: unknown, fallbackCode: string) {
  const detail = errorDetail(error)
  const voiceFailure = {
    code: detail?.code ?? fallbackCode,
    message: detail?.message ??
      (error instanceof Error ? error.message : 'Native voice operation failed'),
    retryable: detail?.retryable ?? true,
    stage: detail?.stage,
    ...(detail?.hresult === undefined ? {} : { hresult: detail.hresult }),
  }
  return new NativeVoiceOperationError({
    message: voiceFailure.message,
    failure: voiceFailure,
  })
}

function errorDetail(error: unknown): NativeRuntimeError | null {
  const decoded = Schema.decodeUnknownOption(NativeRuntimeErrorCarrierSchema)(
    error,
  )
  return Option.isSome(decoded) ? decoded.value.detail : null
}

export type { NativeVoiceRuntime }
