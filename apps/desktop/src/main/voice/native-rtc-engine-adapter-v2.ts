import { Effect, Option, Schema } from 'effect'
import {
  createInitialVoiceMediaDesiredState,
  type RtcEngineAdapter,
  type VoiceDisconnectCause,
  type VoiceEngineEvent,
  type VoiceLease,
  type VoiceMediaDesiredState,
  type VoiceMediaKind,
  type VoiceRemoteAudioSettings,
} from '@syrnike13/platform'
import {
  EngineDesiredStateSchema,
  MediaLifecycleError,
  createInactiveMediaPaths,
  mediaLifecycleError,
  type EngineDesiredState,
  type MediaEngineSnapshot,
  type MediaLifecycleEvent,
  type MediaLifecycleFailure,
} from '../media-runtime/contract'
import type { MediaRuntimeSupervisor } from '../media-runtime/media-runtime-supervisor'
import { getNativeDiagnosticCorrelationId } from '../native-runtime/diagnostic-incidents'

type RuntimePort = Pick<MediaRuntimeSupervisor,
  'start' | 'getSnapshot' | 'getHostEpoch' | 'getFailureEpisodeId' | 'onStateChange' | 'onEvent' |
  'onSnapshot' | 'installCredentialLease' | 'applyDesiredState' | 'querySnapshot' | 'shutdown'
>

type RoomWaiter = {
  revision: number
  roomLeaseId: string | null
  resolve(): void
  reject(error: Error): void
  cleanup(): void
}

type RetryRevisions = Record<VoiceMediaKind, number>
type PreviewDemand = { rendererId: string; screen: boolean; camera: boolean }
type RoomBinding = { lease: VoiceLease; credentialLeaseId: string; revision: number }

const emptyAudioSettings: VoiceRemoteAudioSettings = {
  revision: 0, userVolumes: {}, userMutes: {}, streamVolumes: {}, streamMutes: {},
}

function mixSettings(volumes: Readonly<Record<string, number>>, mutes: Readonly<Record<string, boolean>>) {
  return [...new Set([...Object.keys(volumes), ...Object.keys(mutes)])].sort().map(identity => ({
    identity, volume: volumes[identity] ?? 1, muted: mutes[identity] ?? false,
  }))
}

function projectDesiredState(
  revision: number,
  binding: RoomBinding | null,
  desired: VoiceMediaDesiredState,
  audio: VoiceRemoteAudioSettings,
  retries: RetryRevisions,
  warm: boolean,
  meterDemand: boolean,
  preview: PreviewDemand | null,
  remoteVideoDemand: EngineDesiredState['remoteVideoDemand'],
): EngineDesiredState {
  const connected = binding !== null
  const value: EngineDesiredState = {
    revision,
    room: binding ? {
      roomId: binding.lease.channelId,
      participantIdentity: binding.lease.credential.participantIdentity,
      credentialLeaseId: binding.credentialLeaseId,
    } : null,
    microphone: connected || warm ? {
      // Server mute revokes the SFU microphone publication. Keep capture warm
      // and let permission restoration create a fresh sender in the same Room.
      state: connected && !desired.serverMuted ? 'on' : 'warm',
      deviceId: desired.microphoneDeviceId ?? null,
      muted: desired.effectiveMuted,
      pushToTalk: desired.inputMode === 'push_to_talk',
      pushToTalkHeld: desired.pushToTalkHeld,
      bypassSystemProcessing: desired.bypassSystemAudioInputProcessing,
      automaticGainControl: desired.automaticGainControl,
      noiseSuppression: desired.noiseSuppression,
      echoCancellation: desired.echoCancellation,
      inputVolume: desired.inputVolume,
      gateEnabled: desired.voiceGateEnabled,
      gateThresholdDb: desired.voiceGateThresholdDb,
      gateAutoThreshold: desired.voiceGateAutoThreshold,
      meterDemand,
      retryRevision: retries.microphone,
    } : { state: 'off' },
    camera: connected && desired.cameraEnabled && !cameraPolicyFailure(binding, desired) ? {
      state: 'on', deviceId: desired.cameraDeviceId ?? null,
      profile: desired.cameraProfile, publication: true,
      previewRendererId: preview?.camera ? preview.rendererId : null,
      retryRevision: retries.camera,
    } : { state: 'off' },
    screen: connected && desired.screenEnabled && desired.screenSourceId ? {
      state: 'on', sourceId: desired.screenSourceId,
      width: desired.screenWidth ?? 1920, height: desired.screenHeight ?? 1080,
      fps: desired.screenFps ?? 60, bitrate: desired.screenBitrate ?? 8_000_000,
      audioMode: desired.screenAudioEnabled ? desired.screenAudioMode : 'none',
      audioBitrate: desired.screenAudioBitrate ?? 128_000,
      previewRendererId: preview?.screen ? preview.rendererId : null,
      retryRevision: retries.screen, audioRetryRevision: retries.screen_audio,
    } : { state: 'off' },
    output: connected ? {
      state: 'on', deviceId: desired.outputDeviceId ?? null,
      deafened: desired.userDeafened || desired.serverDeafened,
      volume: desired.outputVolume,
      users: mixSettings(audio.userVolumes, audio.userMutes),
      streams: mixSettings(audio.streamVolumes, audio.streamMutes),
      retryRevision: retries.output,
    } : { state: 'off' },
    remoteVideoDemand: connected && preview ? remoteVideoDemand : [],
    rendererId: preview?.rendererId ?? null,
  }
  const decoded = Schema.decodeUnknownOption(EngineDesiredStateSchema, { onExcessProperty: 'error' })(value)
  if (Option.isNone(decoded)) {
    throw mediaLifecycleError('media_intent_invalid', 'Media settings are outside the supported bounds', 'desired_state')
  }
  return decoded.value
}

function cameraPolicyFailure(
  binding: RoomBinding | null,
  desired: VoiceMediaDesiredState,
): MediaLifecycleFailure | undefined {
  if (!binding || !desired.cameraEnabled ||
      binding.lease.credential.cameraProfiles.includes(desired.cameraProfile)) return undefined
  return {
    code: 'camera_profile_not_permitted',
    message: 'Выбранное качество камеры недоступно для этого аккаунта или канала. Выберите разрешённое качество в настройках.',
    stage: 'camera_policy', retryable: false,
  }
}

/** Main-process owner of one latest immutable desired snapshot. No media lifecycle
 * command or native recovery decision is synthesized here. Voice Director owns
 * the lease and receives only Room/runtime terminal loss as a voice failure. */
export class NativeRtcEngineAdapterV2 implements RtcEngineAdapter {
  private readonly listeners = new Set<(event: VoiceEngineEvent) => void>()
  private readonly snapshotListeners = new Set<(snapshot: MediaEngineSnapshot) => void>()
  private readonly unsubscribe: Array<() => void>
  private desired = createInitialVoiceMediaDesiredState()
  private audio = emptyAudioSettings
  private readonly retries: RetryRevisions = { microphone: 0, output: 0, camera: 0, screen: 0, screen_audio: 0 }
  private binding: RoomBinding | null = null
  private preview: PreviewDemand | null = null
  private remoteVideoDemand: EngineDesiredState['remoteVideoDemand'] = []
  private revision = 0
  private warm = false
  private meterDemand = false
  private started = false
  private disposed = false
  private epoch = 0
  private installedLeaseId: string | null = null
  private appliedRevision = 0
  private latest: EngineDesiredState | null = null
  private current: MediaEngineSnapshot = {
    engineState: 'stopped', acceptedRevision: null, desiredState: null,
    roomState: 'off', tracks: createInactiveMediaPaths(),
  }
  private flushPromise: Promise<void> | null = null
  private flushRequested = false
  private shutdownPromise: Promise<void> | null = null
  private waiter: RoomWaiter | null = null
  private terminalReported = false

  constructor(
    private readonly runtime: RuntimePort,
    private readonly newId = () => crypto.randomUUID(),
    private readonly reportControlFailure: (failure: MediaLifecycleFailure) => void = () => undefined,
    private readonly onDispose: () => void = () => undefined,
    private readonly isAvailable: () => boolean = () => true,
  ) {
    this.unsubscribe = [
      runtime.onStateChange(snapshot => {
        if (this.disposed) return
        const epoch = runtime.getHostEpoch()
        if (snapshot.status !== 'ready' || this.epoch !== epoch) {
          // Observed media belongs to one host. Clear it before availability
          // listeners can combine a replacement host with the old media paths.
          this.current = {
            engineState: 'stopped', acceptedRevision: null, desiredState: null,
            roomState: 'off', tracks: createInactiveMediaPaths(),
          }
          for (const listener of this.snapshotListeners) listener(this.current)
        }
        this.emitAvailability()
        if (snapshot.status === 'ready') {
          if (this.epoch !== epoch) {
            this.epoch = epoch
            this.appliedRevision = 0
            this.installedLeaseId = null
          }
          this.scheduleFlush()
        } else if ((snapshot.status === 'recovering' || snapshot.status === 'failed') && snapshot.failure) {
          // A replacement process cannot resume the old Room. Voice Director
          // must retire its authority and acquire a fresh lease before replay.
          this.failRoom(snapshot.failure)
        }
      }),
      runtime.onEvent(event => this.observeEvent(event)),
      runtime.onSnapshot(snapshot => this.observeSnapshot(snapshot)),
    ]
  }

  connect(lease: VoiceLease, desired: VoiceMediaDesiredState, signal: AbortSignal): Promise<void> {
    if (this.disposed) return Promise.reject(mediaLifecycleError('media_disposed', 'Media runtime has stopped', 'connect'))
    if (signal.aborted) return Promise.reject(new DOMException('Voice operation superseded', 'AbortError'))
    this.cancelWaiter()
    this.binding = { lease: structuredClone(lease), credentialLeaseId: this.newId(), revision: this.revision + 1 }
    this.desired = { ...desired }
    this.terminalReported = false
    this.started = true
    this.commitDesired()
    return this.waitForRoom(this.binding.credentialLeaseId, signal)
  }

  disconnect(_cause: VoiceDisconnectCause): Promise<void> {
    if (this.disposed) return this.shutdownPromise ?? Promise.resolve()
    this.cancelWaiter()
    this.binding = null
    this.warm = false
    this.remoteVideoDemand = []
    this.desired = { ...this.desired, cameraEnabled: false, screenEnabled: false, screenAudioEnabled: false }
    this.commitDesired()
    const status = this.runtime.getSnapshot().status
    if (!this.started || status === 'stopped' || status === 'failed') return Promise.resolve()
    return this.waitForRoom(null)
  }

  updateDesiredMedia(desired: VoiceMediaDesiredState): void {
    if (this.disposed) return
    this.desired = { ...desired }
    this.commitDesired()
  }

  updateRemoteAudioSettings(settings: VoiceRemoteAudioSettings): void {
    if (this.disposed || settings.revision < this.audio.revision) return
    this.audio = structuredClone(settings)
    this.commitDesired()
  }

  retryMedia(kind: VoiceMediaKind): void {
    if (this.disposed) return
    ++this.retries[kind]
    this.commitDesired()
  }

  rendererReady(rendererId: string): void {
    if (this.disposed) return
    this.preview = { rendererId, screen: false, camera: false }
    this.remoteVideoDemand = []
    this.commitDesired()
  }

  rendererGone(rendererId: string): void {
    if (this.preview?.rendererId !== rendererId) return
    this.preview = null
    this.remoteVideoDemand = []
    this.commitDesired()
  }

  setPreviewDemand(rendererId: string, screen: boolean, camera: boolean): void {
    if (this.preview?.rendererId !== rendererId) return
    this.preview = { rendererId, screen, camera }
    this.commitDesired()
  }

  setRemoteVideoDemand(rendererId: string, demand: EngineDesiredState['remoteVideoDemand']): void {
    if (this.preview?.rendererId !== rendererId) return
    this.remoteVideoDemand = structuredClone(demand)
    this.commitDesired()
  }

  prewarmMicrophoneEffect() {
    return Effect.tryPromise({
      try: () => {
        this.warm = true
        this.started = true
        this.commitDesired()
        return this.flush()
      },
      catch: normalizeFailure,
    })
  }

  async setMicrophonePreview(enabled: boolean): Promise<void> {
    if (this.disposed) return
    this.meterDemand = enabled
    if (enabled) {
      this.warm = true
      this.started = true
    }
    this.commitDesired()
    if (this.started) await this.flush()
  }

  subscribe(listener: (event: VoiceEngineEvent) => void): () => void {
    this.listeners.add(listener)
    listener(this.availabilityEvent())
    return () => this.listeners.delete(listener)
  }

  onSnapshot(listener: (snapshot: MediaEngineSnapshot) => void): () => void {
    this.snapshotListeners.add(listener)
    return () => this.snapshotListeners.delete(listener)
  }

  snapshot(): MediaEngineSnapshot { return this.current }
  desiredSnapshot(): EngineDesiredState | null { return this.latest }
  telemetry() { return this.current }

  dispose(): Promise<void> {
    if (this.shutdownPromise) return this.shutdownPromise
    this.disposed = true
    this.cancelWaiter()
    this.binding = null
    this.latest = null
    for (const unsubscribe of this.unsubscribe) unsubscribe()
    this.listeners.clear()
    this.snapshotListeners.clear()
    this.onDispose()
    this.shutdownPromise = this.runtime.shutdown()
    return this.shutdownPromise
  }

  private commitDesired(): void {
    if (this.disposed) return
    this.latest = projectDesiredState(++this.revision, this.binding, this.desired,
      this.audio, this.retries, this.warm, this.meterDemand, this.preview, this.remoteVideoDemand)
    this.scheduleFlush()
  }

  private scheduleFlush(): void {
    if (!this.started || this.disposed) return
    this.flushRequested = true
    if (this.flushPromise) return
    void this.flush().catch(error => {
      if (this.disposed || this.runtime.getSnapshot().status === 'recovering') return
      const failure = normalizeFailure(error)
      this.reportControlFailure(failure.failure)
      if (this.waiter) {
        const waiter = this.waiter
        this.waiter = null
        waiter.cleanup()
        waiter.reject(failure)
      }
    })
  }

  private flush(): Promise<void> {
    if (this.flushPromise) return this.flushPromise
    // Install the in-flight promise before start() can synchronously notify ready.
    this.flushPromise = Promise.resolve().then(() => this.flushLatest()).finally(() => {
      this.flushPromise = null
      if (this.flushRequested && !this.disposed && this.runtime.getSnapshot().status === 'ready') this.scheduleFlush()
    })
    return this.flushPromise
  }

  private async flushLatest(): Promise<void> {
    if (!this.isAvailable()) throw mediaLifecycleError(
      'media_unavailable', 'Native media is unavailable on this device', 'native_runtime', false,
    )
    await this.runtime.start()
    this.flushRequested = false
    while (!this.disposed && this.latest && this.appliedRevision !== this.latest.revision) {
      this.flushRequested = false
      if (this.binding && this.terminalReported) return
      const epoch = this.runtime.getHostEpoch()
      if (epoch !== this.epoch) {
        this.epoch = epoch
        this.installedLeaseId = null
        this.appliedRevision = 0
      }
      const binding = this.binding
      try {
        if (binding && this.installedLeaseId !== binding.credentialLeaseId) {
          await this.runtime.installCredentialLease({
            leaseId: binding.credentialLeaseId,
            serverUrl: binding.lease.credential.url,
            accessToken: binding.lease.credential.token,
          })
          if (this.disposed || epoch !== this.runtime.getHostEpoch()) return
          if (binding && this.terminalReported) return
          this.installedLeaseId = binding.credentialLeaseId
          // Credentials can finish after move/leave. Never replay their old intent.
          if (binding !== this.binding) continue
        }
        const desired = this.latest
        const accepted = await this.runtime.applyDesiredState(desired)
        if (this.disposed || epoch !== this.runtime.getHostEpoch()) return
        this.appliedRevision = accepted.acceptedRevision
        if (this.latest.revision !== desired.revision) continue
        const snapshot = await this.runtime.querySnapshot()
        if (this.disposed || epoch !== this.runtime.getHostEpoch()) return
        this.observeSnapshot(snapshot)
      } catch (error) {
        // A late rejection from a retired host or lease must not reject the
        // replacement Room's waiter. Its pending intent will flush separately.
        if (this.disposed || epoch !== this.runtime.getHostEpoch() || binding !== this.binding) return
        throw error
      }
    }
  }

  private waitForRoom(roomLeaseId: string | null, signal?: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
      const onAbort = () => {
        if (this.waiter !== waiter) return
        this.cancelWaiter()
        this.binding = null
        this.warm = false
        this.commitDesired()
      }
      const timer = setTimeout(() => {
        if (this.waiter !== waiter) return
        waiter.cleanup()
        this.waiter = null
        if (roomLeaseId) {
          this.binding = null
          this.warm = false
          this.commitDesired()
        }
        reject(mediaLifecycleError('media_room_deadline', 'Voice connection did not settle within its deadline', 'room', true))
      }, roomLeaseId ? 30_000 : 15_000)
      timer.unref?.()
      const waiter: RoomWaiter = {
        revision: this.revision, roomLeaseId, resolve, reject,
        cleanup: () => { clearTimeout(timer); signal?.removeEventListener('abort', onAbort) },
      }
      this.waiter = waiter
      signal?.addEventListener('abort', onAbort, { once: true })
      if (signal?.aborted) onAbort()
      else this.settleRoomWaiter()
    })
  }

  private cancelWaiter(): void {
    const waiter = this.waiter
    if (!waiter) return
    this.waiter = null
    waiter.cleanup()
    waiter.reject(new DOMException('Voice operation superseded', 'AbortError'))
  }

  private settleRoomWaiter(): void {
    const waiter = this.waiter
    if (!waiter || (this.current.acceptedRevision ?? 0) < waiter.revision) return
    if ((this.current.desiredState?.room?.credentialLeaseId ?? null) !== waiter.roomLeaseId) return
    const settled = waiter.roomLeaseId
      ? this.current.roomState === 'connected'
      : this.current.roomState === 'off' && Object.values(this.current.tracks).every(path => path.state === 'off')
    if (!settled) return
    this.waiter = null
    waiter.cleanup()
    waiter.resolve()
  }

  private observeEvent(event: MediaLifecycleEvent): void {
    if (this.disposed || !this.latest) return
    if (event.type === 'roomStateChanged') {
      if (event.revision !== this.latest.revision || this.current.acceptedRevision !== event.revision) return
      this.observeSnapshot({
        ...this.current,
        roomState: event.state, roomFailure: event.failure,
      })
    } else if (event.type === 'trackStateChanged') {
      if (event.revision !== this.latest.revision || this.current.acceptedRevision !== event.revision) return
      this.observeSnapshot({
        ...this.current,
        tracks: { ...this.current.tracks, [event.track]: {
          revision: event.revision, state: event.state, warning: event.warning, failure: event.failure,
        } },
      })
    }
  }

  private observeSnapshot(snapshot: MediaEngineSnapshot): void {
    if (this.disposed || !this.latest || snapshot.acceptedRevision !== this.latest.revision) return
    if (this.binding && this.terminalReported) return
    if (snapshot.desiredState?.room?.credentialLeaseId !== this.latest.room?.credentialLeaseId) return
    const cameraFailure = cameraPolicyFailure(this.binding, this.desired)
    const projected: MediaEngineSnapshot = cameraFailure ? {
      ...snapshot,
      tracks: {
        ...snapshot.tracks,
        camera: {
          revision: this.latest.revision, state: 'failed',
          warning: false, failure: cameraFailure,
        },
      },
    } : snapshot
    this.current = projected
    this.settleRoomWaiter()
    for (const kind of ['microphone', 'output', 'camera', 'screen', 'screen_audio'] satisfies VoiceMediaKind[]) {
      const path = projected.tracks[kind]
      if (path.revision !== this.latest.revision) continue
      this.emitBound({ type: 'mediaState', kind, media: {
        state: path.state, error: path.failure ? this.projectFailure(path.failure) : undefined,
      } })
    }
    if (snapshot.roomState === 'failed' && snapshot.roomFailure) this.failRoom(snapshot.roomFailure)
    for (const listener of this.snapshotListeners) listener(projected)
  }

  private failRoom(failure: MediaLifecycleFailure): void {
    const projectedFailure = this.projectFailure(failure)
    if (this.waiter) {
      const waiter = this.waiter
      this.waiter = null
      waiter.cleanup()
      waiter.reject(new MediaLifecycleError({ failure: projectedFailure }))
    }
    if (!this.binding || this.terminalReported) return
    this.terminalReported = true
    this.emitBound({ type: 'terminalFailure', failure: projectedFailure })
  }

  private projectFailure(failure: MediaLifecycleFailure) {
    const episodeId = this.runtime.getFailureEpisodeId(failure.causeSequence)
    return episodeId
      ? { ...failure, diagnosticCorrelationId: getNativeDiagnosticCorrelationId(episodeId) }
      : failure
  }

  private emitBound(event: BoundEvent): void {
    if (!this.binding) return
    const { operationId, connectionEpoch } = this.binding.lease
    for (const listener of this.listeners) listener({ ...event, operationId, connectionEpoch })
  }

  private availabilityEvent(): VoiceEngineEvent {
    if (!this.isAvailable()) return {
      type: 'availabilityChanged', available: false, retryable: false,
      failure: {
        code: 'media_unavailable', message: 'Native media is unavailable on this device',
        stage: 'native_runtime', retryable: false,
      },
    }
    const state = this.runtime.getSnapshot()
    return {
      type: 'availabilityChanged', available: state.status === 'ready' || state.status === 'stopped',
      retryable: state.failure?.retryable ?? true,
      failure: state.failure ? this.projectFailure(state.failure) : undefined,
    }
  }
  private emitAvailability(): void {
    const event = this.availabilityEvent()
    for (const listener of this.listeners) listener(event)
  }
}

type BoundEvent =
  | { type: 'terminalFailure'; failure: MediaLifecycleFailure }
  | { type: 'mediaState'; kind: VoiceMediaKind; media: { state: 'off' | 'starting' | 'running' | 'muted' | 'failed'; error?: MediaLifecycleFailure } }

function normalizeFailure(error: unknown): MediaLifecycleError {
  return error instanceof MediaLifecycleError ? error : mediaLifecycleError(
    'media_control_failed', 'Media control operation failed', 'control', true,
  )
}
