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

import type {
  NativeRuntimeCommand,
  NativeRuntimeEvent,
} from '../native-runtime/contract'
import type {
  NativeRuntimeSupervisor,
  NativeRuntimeSupervisorSnapshot,
} from '../native-runtime/runtime-supervisor'

const VOICE_OPERATION_TIMEOUT_MS = 20_000
const MEDIA_CONTROL_TIMEOUT_MS = 2_000
const OUTPUT_START_TIMEOUT_MS = 5_000
const MICROPHONE_CONFIG_TIMEOUT_MS = 5_000

type NativeVoiceRuntime = Pick<
  NativeRuntimeSupervisor,
  | 'request'
  | 'onEvent'
  | 'onStateChange'
  | 'allocateGeneration'
  | 'allocateMicrophoneConfigRevision'
>

type ActiveVoiceConnection = {
  lease: VoiceLease
  voiceGeneration: number
  voiceReady: boolean
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
  cameraStarted: boolean
  selfSpeaking: boolean
  remoteSpeakingUserIds: Set<string>
  speakingUserIds: Set<string>
}

export class NativeRtcEngineAdapter implements RtcEngineAdapter {
  private readonly listeners = new Set<(event: VoiceEngineEvent) => void>()
  private readonly unsubscribeEvent: () => void
  private readonly unsubscribeState: () => void
  private desired: VoiceMediaDesiredState | null = null
  private active: ActiveVoiceConnection | null = null
  private mediaRevision = 0
  private mediaHandledRevision = 0
  private mediaReconcile: Promise<void> | null = null
  private microphoneAppliedConfigRevision = 0
  private microphoneConfigKey: string | null = null
  private microphoneConfigPromise: Promise<void> | null = null
  private microphoneConfigScheduled = false
  private microphonePipelineWarm = false
  private microphoneWarmPromise: Promise<void> | null = null
  private runtimeEpoch = 0
  private observedHostEpoch: number | null = null
  private terminalRuntimeLossEpoch: number | null = null
  private runtimeAvailable = true
  private runtimeLost = false
  private availabilityRetryable = true
  private disposed = false
  private remoteAudioSettings: VoiceRemoteAudioSettings | null = null

  constructor(
    private readonly runtime: NativeVoiceRuntime,
    private readonly excludeProcessId: () => number = () => process.pid,
  ) {
    this.unsubscribeEvent = runtime.onEvent((event) => this.handleRuntimeEvent(event))
    this.unsubscribeState = runtime.onStateChange((snapshot) =>
      this.handleRuntimeState(snapshot),
    )
  }

  async connect(
    lease: VoiceLease,
    desired: VoiceMediaDesiredState,
    signal: AbortSignal,
  ) {
    if (this.disposed) throw new Error('Native RTC adapter is disposed')
    if (lease.rtcEngine !== 'windows_native') {
      throw new Error('Native RTC adapter received a non-native Voice Lease')
    }
    this.desired = desired
    const generation = this.runtime.allocateGeneration('voice')
    const active: ActiveVoiceConnection = {
      lease,
      voiceGeneration: generation,
      voiceReady: false,
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
      cameraStarted: false,
      selfSpeaking: false,
      remoteSpeakingUserIds: new Set(),
      speakingUserIds: new Set(),
    }
    this.active = active

    try {
      await raceWithAbort(
        this.runtime.request(
          {
            type: 'connectVoice',
            sessionId: lease.connectionEpoch,
            generation,
            options: { livekit: lease.credential },
          },
          VOICE_OPERATION_TIMEOUT_MS,
        ),
        signal,
      )
    } catch (error) {
      if (isAbortError(error)) throw error
      throw voiceFailureError(error, 'native_voice_connect_failed')
    }
    this.assertCurrent(active)
    if (signal.aborted) throw abortError()
    active.voiceReady = true

    await this.replayRemoteAudioSettings(active)

    // Membership is independent from track readiness. Track actors reconcile
    // only after the one shared Room is ready and never race their own lane.
    this.requestMediaReconcile()
  }

  async disconnect(_cause: VoiceDisconnectCause) {
    const active = this.active
    this.active = null
    this.mediaRevision += 1
    if (!active) return
    active.selfSpeaking = false
    active.remoteSpeakingUserIds.clear()
    active.speakingUserIds.clear()
    if (this.runtimeLost) return

    await Promise.allSettled([
      active.microphoneGeneration !== null
        ? this.runtime.request(
            {
              type: 'disconnectMicrophone',
              sessionId: active.lease.connectionEpoch,
              generation: this.runtime.allocateGeneration('microphone'),
            },
            MEDIA_CONTROL_TIMEOUT_MS,
          )
        : Promise.resolve(),
      this.runtime.request(
        {
            type: 'disconnectScreen',
            sessionId: active.lease.connectionEpoch,
            generation: this.runtime.allocateGeneration('screen'),
        },
        MEDIA_CONTROL_TIMEOUT_MS,
      ),
      active.cameraStarted
        ? this.runtime.request(
            {
              type: 'disconnectCamera',
              sessionId: active.lease.connectionEpoch,
              generation: this.runtime.allocateGeneration('camera'),
            },
            MEDIA_CONTROL_TIMEOUT_MS,
          )
        : Promise.resolve(),
    ])
    await this.runtime.request(
      {
        type: 'disconnectVoice',
        sessionId: active.lease.connectionEpoch,
        generation: this.runtime.allocateGeneration('voice'),
      },
      MEDIA_CONTROL_TIMEOUT_MS,
    )
  }

  updateDesiredMedia(desired: VoiceMediaDesiredState) {
    this.desired = desired
    const active = this.active
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
    if (active?.voiceReady) void this.replayRemoteAudioSettings(active)
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
      if (active.voiceReady) void this.replayRemoteAudioSettings(active)
      this.requestMediaReconcile()
    }
  }

  subscribe(listener: (event: VoiceEngineEvent) => void) {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  prewarmMicrophone() {
    if (this.disposed) return Promise.reject(new Error('Native RTC adapter is disposed'))
    return this.ensureMicrophonePipelineWarm()
  }

  dispose() {
    if (this.disposed) return
    this.disposed = true
    this.unsubscribeEvent()
    this.unsubscribeState()
    this.listeners.clear()
  }

  private scheduleMicrophoneConfiguration() {
    if (this.microphoneConfigScheduled) return
    this.microphoneConfigScheduled = true
    queueMicrotask(() => {
      this.microphoneConfigScheduled = false
      if (this.disposed) return
      void this.ensureMicrophoneConfiguration().catch(() => undefined)
    })
  }

  private async replayRemoteAudioSettings(active: ActiveVoiceConnection) {
    const settings = this.remoteAudioSettings
    if (!settings) return
    try {
      await this.runtime.request(
        {
          type: 'configureRemoteAudio',
          sessionId: active.lease.connectionEpoch,
          generation: active.voiceGeneration,
          settings,
        },
        MEDIA_CONTROL_TIMEOUT_MS,
      )
      this.assertCurrent(active)
    } catch (error) {
      if (this.active === active) {
        this.emitMediaFailure(
          active,
          'output',
          error,
          'remote_audio_config_failed',
        )
      }
    }
  }

  private async ensureMicrophoneConfiguration() {
    while (this.desired) {
      const desired = this.desired
      const config = microphoneConfig(desired)
      const key = JSON.stringify(config)
      if (this.microphoneConfigKey === key) return
      if (this.microphoneConfigPromise) {
        await this.microphoneConfigPromise
        continue
      }

      const revision = this.runtime.allocateMicrophoneConfigRevision()
      const runtimeEpoch = this.runtimeEpoch
      const request = this.runtime
        .request(
          {
            type: 'configureMicrophone',
            revision,
            config,
          },
          MICROPHONE_CONFIG_TIMEOUT_MS,
        )
        .then(() => {
          if (runtimeEpoch === this.runtimeEpoch) {
            this.microphoneConfigKey = key
            this.microphoneAppliedConfigRevision = revision
          }
        })
        .catch((error) => {
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
          throw error
        })
      this.microphoneConfigPromise = request
      try {
        await request
      } finally {
        if (this.microphoneConfigPromise === request) {
          this.microphoneConfigPromise = null
        }
      }
    }
  }

  private async ensureMicrophone(
    active: ActiveVoiceConnection,
    desired: VoiceMediaDesiredState,
  ) {
    if (active !== this.active || active.microphoneReady) return
    await this.ensureMicrophonePipelineWarm()
    this.assertCurrent(active)
    const generation = this.runtime.allocateGeneration('microphone')
    active.microphoneGeneration = generation
    this.emitMedia(active, 'microphone', { state: 'starting' })
    try {
      await this.runtime.request(
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
      )
      this.assertCurrent(active)
      if (active.microphoneGeneration !== generation) return
      active.microphoneReady = true
      active.appliedMicrophoneMuted = desired.effectiveMuted
      this.updateSelfSpeaking(active, false)
      this.emitMedia(active, 'microphone', {
        state: desired.effectiveMuted ? 'muted' : 'running',
      })
    } catch (error) {
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
    }
  }

  private async ensureMicrophonePipelineWarm() {
    if (this.microphonePipelineWarm) return
    if (this.microphoneWarmPromise) {
      await this.microphoneWarmPromise
      return
    }
    const operation = (async () => {
      await this.ensureMicrophoneConfiguration()
      const desired = this.desired
      if (!desired) return
      const runtimeEpoch = this.runtimeEpoch
      await this.runtime.request(
        {
          type: 'warmMicrophone',
          generation: this.runtime.allocateGeneration('microphone'),
          config: microphoneConfig(desired),
        },
        VOICE_OPERATION_TIMEOUT_MS,
      )
      if (runtimeEpoch === this.runtimeEpoch) this.microphonePipelineWarm = true
    })()
    this.microphoneWarmPromise = operation
    try {
      await operation
    } finally {
      if (this.microphoneWarmPromise === operation) {
        this.microphoneWarmPromise = null
      }
    }
  }

  private requestMediaReconcile() {
    this.mediaRevision += 1
    this.ensureMediaReconcile()
  }

  private ensureMediaReconcile() {
    if (
      this.mediaReconcile ||
      !this.active?.voiceReady ||
      !this.desired
    ) {
      return
    }
    this.mediaReconcile = this.reconcileMediaLoop().finally(() => {
      this.mediaReconcile = null
      if (
        this.active &&
        this.desired &&
        this.mediaHandledRevision !== this.mediaRevision
      ) {
        this.ensureMediaReconcile()
      }
    })
  }

  private async reconcileMediaLoop() {
    let handledRevision = -1
    while (
      this.active &&
      this.desired &&
      handledRevision !== this.mediaRevision
    ) {
      handledRevision = this.mediaRevision
      const active = this.active
      const desired = this.desired
      await Promise.allSettled([
        this.reconcileMicrophone(active),
        this.applyScreen(active, desired),
        this.applyCamera(active, desired),
        this.applyOutput(active, desired),
      ])
      this.mediaHandledRevision = handledRevision
    }
  }

  private async reconcileMicrophone(active: ActiveVoiceConnection) {
    await this.ensureMicrophoneConfiguration()
    this.assertCurrent(active)
    const desiredBeforeStart = this.desired
    if (!desiredBeforeStart) return
    await this.ensureMicrophone(active, desiredBeforeStart)
    this.assertCurrent(active)
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
    try {
      await this.runtime.request(
        {
          type: 'setMicrophoneMuted',
          sessionId: active.lease.connectionEpoch,
          generation,
          muted: desired.effectiveMuted,
        },
        MEDIA_CONTROL_TIMEOUT_MS,
      )
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
    } catch (error) {
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
    }
  }

  private async applyCamera(
    active: ActiveVoiceConnection,
    desired: VoiceMediaDesiredState,
  ) {
    const cameraKey = desired.cameraEnabled
      ? `${desired.cameraDeviceId ?? ''}|1280|720|30`
      : null
    if (!desired.cameraEnabled) {
      if (!active.cameraStarted) return
      active.cameraStarted = false
      active.cameraKey = null
      active.cameraGeneration = null
      await this.runtime.request(
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
      await this.runtime.request(
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
    try {
      await this.runtime.request(
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
      )
      this.assertCurrent(active)
      if (active.cameraGeneration !== generation) return
      this.emitMedia(active, 'camera', { state: 'running' })
    } catch (error) {
      if (
        this.active !== active ||
        active.cameraGeneration !== generation
      ) return
      this.retireMediaKind(active, 'camera')
      this.emitMediaFailure(active, 'camera', error, 'camera_start_failed')
    }
  }

  private async applyOutput(
    active: ActiveVoiceConnection,
    desired: VoiceMediaDesiredState,
  ) {
    const deafened = desired.userDeafened || desired.serverDeafened
    const volume = desired.outputVolume
    const outputKey = `${deafened}|${desired.outputDeviceId ?? ''}|${volume}`
    if (active.outputKey === outputKey) return
    const previousOutputKey = active.outputKey
    const previousOutputMedia = active.outputMedia
    active.outputKey = outputKey
    try {
      await this.runtime.request(
        {
          type: 'configureVoiceOutput',
          sessionId: active.lease.connectionEpoch,
          generation: active.voiceGeneration,
          deafened,
          deviceId: desired.outputDeviceId,
          volume,
        },
        OUTPUT_START_TIMEOUT_MS,
      )
      this.assertCurrent(active)
      if (active.outputKey !== outputKey) return
      this.emitMedia(active, 'output', {
        state: deafened ? 'muted' : 'running',
      })
    } catch (error) {
      if (this.active !== active || active.outputKey !== outputKey) return
      const detail = errorDetail(error)
      if (
        previousOutputKey !== null &&
        detail?.code !== 'audio_output_rollback_failed'
      ) {
        active.outputKey = previousOutputKey
        this.emitMedia(active, 'output', {
          state: previousOutputMedia.state,
          error: {
            code: detail?.code ?? 'output_config_rolled_back',
            message: detail?.message ??
              (error instanceof Error
                ? error.message
                : 'Output configuration failed; previous output remains active'),
            retryable: detail?.retryable ?? true,
            ...(detail?.stage === undefined ? {} : { stage: detail.stage }),
            ...(detail?.hresult === undefined ? {} : { hresult: detail.hresult }),
          },
        })
        return
      }
      this.retireMediaKind(active, 'output')
      this.emitMediaFailure(active, 'output', error, 'output_config_failed')
    }
  }

  private async applyScreen(
    active: ActiveVoiceConnection,
    desired: VoiceMediaDesiredState,
  ) {
    const sourceKey = desired.screenEnabled
      ? [
          desired.screenSourceId,
          desired.screenAudioEnabled,
          desired.screenWidth,
          desired.screenHeight,
          desired.screenFps,
          desired.screenBitrate,
          desired.screenAudioBitrate,
        ].join('|')
      : null
    if (!desired.screenEnabled || !desired.screenSourceId) {
      if (!active.screenStarted) return
      const generation = this.runtime.allocateGeneration('screen')
      active.screenStarted = false
      active.screenGeneration = null
      active.screenSourceKey = null
      await this.runtime.request(
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
    if (active.screenStarted && active.screenSourceKey === sourceKey) return
    if (active.screenStarted) {
      await this.runtime.request(
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
    try {
      await this.runtime.request(
        {
          type: 'connectScreen',
          sessionId: active.lease.connectionEpoch,
          generation,
          options: {
            participantIdentity: active.lease.credential.participantIdentity,
          },
        },
        VOICE_OPERATION_TIMEOUT_MS,
      )
      this.assertCurrent(active)
      if (active.screenGeneration !== generation) return
      await this.runtime.request(
        {
          type: 'startScreenCapture',
          sessionId: active.lease.connectionEpoch,
          generation,
          excludeProcessId: this.excludeProcessId(),
          options: {
            kind: 'screen',
            requestId: `screen-${active.lease.connectionEpoch}`,
            sourceId: desired.screenSourceId,
            width: desired.screenWidth ?? 1_920,
            height: desired.screenHeight ?? 1_080,
            fps: desired.screenFps ?? 30,
            bitrate: desired.screenBitrate ?? 6_000_000,
            audioBitrate: desired.screenAudioBitrate ?? 128_000,
            audio: { requested: desired.screenAudioEnabled },
            participantIdentity: active.lease.credential.participantIdentity,
          },
        },
        VOICE_OPERATION_TIMEOUT_MS,
      )
      this.assertCurrent(active)
      if (active.screenGeneration !== generation) return
      this.emitMedia(active, 'screen', { state: 'running' })
      this.emitMedia(active, 'screen_audio', {
        state: desired.screenAudioEnabled ? 'running' : 'off',
      })
    } catch (error) {
      if (
        this.active !== active ||
        active.screenGeneration !== generation
      ) return
      this.retireMediaKind(active, 'screen')
      this.emitMediaFailure(active, 'screen', error, 'screen_start_failed')
    }
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
        retryable: !targetClosed,
        stage: 'screen_capture',
      }
      this.emitMedia(active, 'screen', { state: 'failed', error })
      if (this.desired?.screenAudioEnabled) {
        this.emitMedia(active, 'screen_audio', { state: 'failed', error })
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
        this.emitMedia(active, kind, {
          state: 'running',
          error: {
            code:
              kind === 'microphone'
                ? 'microphone_device_fallback'
                : 'output_device_fallback',
            message: event.error.message,
            retryable: false,
          },
        })
      } else if (
        (kind === 'microphone' || kind === 'output') &&
        event.state.status === 'running' &&
        event.state.message ===
          (kind === 'microphone'
            ? 'audio_input_default_recovered'
            : 'audio_output_default_recovered')
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
    const hostEpoch = snapshot.hostEpoch
    if (hostEpoch !== undefined && hostEpoch !== this.observedHostEpoch) {
      this.observedHostEpoch = hostEpoch
      this.runtimeEpoch += 1
      this.microphoneConfigKey = null
      this.microphonePipelineWarm = false
    }
    const available = snapshot.status === 'ready'
    this.runtimeLost =
      snapshot.status === 'recovering' ||
      snapshot.status === 'degraded' ||
      snapshot.status === 'stopped'
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
        retryable: detail?.retryable ?? nativeCode !== 'target_closed',
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

function raceWithAbort<T>(promise: Promise<T>, signal: AbortSignal) {
  if (signal.aborted) return Promise.reject<T>(abortError())
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(abortError())
    signal.addEventListener('abort', onAbort, { once: true })
    promise.then(
      (value) => {
        signal.removeEventListener('abort', onAbort)
        resolve(value)
      },
      (error) => {
        signal.removeEventListener('abort', onAbort)
        reject(error)
      },
    )
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
  return Object.assign(new Error(voiceFailure.message), { failure: voiceFailure })
}

function errorDetail(error: unknown) {
  if (!error || typeof error !== 'object' || !('detail' in error)) return null
  const detail = error.detail
  if (!detail || typeof detail !== 'object') return null
  if (
    !('code' in detail) || typeof detail.code !== 'string' ||
    !('message' in detail) || typeof detail.message !== 'string' ||
    !('retryable' in detail) || typeof detail.retryable !== 'boolean'
  ) {
    return null
  }
  return {
    code: detail.code,
    message: detail.message,
    retryable: detail.retryable,
    stage:
      'stage' in detail && typeof detail.stage === 'string'
        ? detail.stage
        : undefined,
    hresult:
      'hresult' in detail && Number.isSafeInteger(detail.hresult)
        ? Number(detail.hresult)
        : undefined,
  }
}

export type { NativeVoiceRuntime }
