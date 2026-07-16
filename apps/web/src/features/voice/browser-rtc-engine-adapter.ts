import {
  DisconnectReason,
  Room,
  RoomEvent,
  Track,
  type RemoteParticipant,
  type RemoteTrackPublication,
  type LocalTrackPublication,
} from 'livekit-client'
import type {
  RtcEngineAdapter,
  VoiceDisconnectCause,
  VoiceEngineEvent,
  VoiceLease,
  VoiceMediaDesiredState,
  VoiceMediaKind,
  VoiceMediaSnapshot,
} from '@syrnike13/platform'

import {
  createVoiceRoomOptions,
  screenShareAudioCaptureOptions,
  screenShareCombinedPublishOptions,
  voiceAudioProcessingConstraints,
  voiceMicPublishOptions,
} from '#/features/voice/voice-capture'
import { applyMicProcessing } from '#/features/voice/voice-mic-processing'
import { baseVoiceIdentity } from '#/features/voice/native-voice-identity'
import {
  createRemoteAudioMixer,
  type RemoteAudioMixer,
  type RemoteAudioSource,
} from '#/features/voice/remote-audio-mixer'
import {
  createLocalSpeakingDetector,
  type LocalSpeakingDetector,
} from '#/features/voice/local-speaking-detector'
import { voiceListenerStore } from '#/features/voice/voice-listener-store'
import { applyStageScreenPublicationSubscription } from '#/features/voice/voice-stage-subscription'

type ActiveBrowserVoice = {
  lease: VoiceLease
  room: Room
  connected: boolean
  intentionalDisconnect: boolean
  microphonePublication: LocalTrackPublication | null
  microphoneStarting: boolean
  appliedMicrophoneKey: string | null
  appliedMicrophoneDeviceId: string | null
  appliedMicrophoneProcessingKey: string | null
  appliedCameraKey: string | null
  appliedScreenKey: string | null
  appliedOutputKey: string | null
  appliedOutputDeviceId: string | null
  outputRecovering: boolean
  audioMixer: RemoteAudioMixer
  localSpeakingDetector: LocalSpeakingDetector
  localSpeaking: boolean
  remoteSpeakingUserIds: Set<string>
  speakingUserIds: Set<string>
  remoteAudioDecoderSinks: Map<
    string,
    { track: Track; element: HTMLAudioElement }
  >
  unsubscribeListenerSettings: () => void
}

type ScopedVoiceEngineEvent =
  | Omit<Extract<VoiceEngineEvent, { type: 'terminalFailure' }>, 'operationId' | 'connectionEpoch'>
  | Omit<Extract<VoiceEngineEvent, { type: 'mediaState' }>, 'operationId' | 'connectionEpoch'>
  | Omit<Extract<VoiceEngineEvent, { type: 'transientReconnectStarted' }>, 'operationId' | 'connectionEpoch'>
  | Omit<Extract<VoiceEngineEvent, { type: 'transientReconnectSucceeded' }>, 'operationId' | 'connectionEpoch'>
  | Omit<Extract<VoiceEngineEvent, { type: 'speakingChanged' }>, 'operationId' | 'connectionEpoch'>

/**
 * One browser Voice Lease maps to exactly one LiveKit Room and participant.
 * Media failures are reported independently and never recreate that Room.
 */
export class BrowserRtcEngineAdapter implements RtcEngineAdapter {
  private readonly listeners = new Set<(event: VoiceEngineEvent) => void>()
  private readonly roomListeners = new Set<(room: Room | null) => void>()
  private active: ActiveBrowserVoice | null = null
  private desired: VoiceMediaDesiredState | null = null
  private mediaRevision = 0
  private mediaHandledRevision = 0
  private mediaReconcile: Promise<void> | null = null
  private disposed = false

  async connect(
    lease: VoiceLease,
    desired: VoiceMediaDesiredState,
    signal: AbortSignal,
  ) {
    if (this.disposed) throw new Error('Browser RTC adapter is disposed')
    if (lease.rtcEngine !== 'web') {
      throw new Error('Browser RTC adapter received a non-web Voice Lease')
    }
    if (this.active) {
      throw new Error('Browser RTC adapter already owns a Room')
    }

    this.desired = desired
    const room = new Room(createVoiceRoomOptions())
    let active!: ActiveBrowserVoice
    const publishSpeaking = () => {
      if (this.active !== active) return
      const next = new Set(active.remoteSpeakingUserIds)
      if (active.localSpeaking) {
        next.add(baseVoiceIdentity(active.lease.credential.participantIdentity))
      }
      if (sameStringSet(active.speakingUserIds, next)) return
      active.speakingUserIds = next
      this.emitFor(active, {
        type: 'speakingChanged',
        participantIdentities: [...next],
      })
    }
    const localSpeakingDetector = createLocalSpeakingDetector({
      onSpeakingChange: (speaking) => {
        if (this.active !== active) return
        active.localSpeaking = speaking
        publishSpeaking()
      },
    })
    const audioMixer = createRemoteAudioMixer({
      onOutputError: (error) => {
        if (this.active === active) void this.handleOutputFailure(active, error)
      },
      onSpeakingUserIdsChange: (userIds) => {
        if (this.active !== active) return
        active.remoteSpeakingUserIds = new Set(userIds)
        publishSpeaking()
      },
    })
    active = {
      lease,
      room,
      connected: false,
      intentionalDisconnect: false,
      microphonePublication: null,
      microphoneStarting: false,
      appliedMicrophoneKey: null,
      appliedMicrophoneDeviceId: null,
      appliedMicrophoneProcessingKey: null,
      appliedCameraKey: null,
      appliedScreenKey: null,
      appliedOutputKey: null,
      appliedOutputDeviceId: null,
      outputRecovering: false,
      audioMixer,
      localSpeakingDetector,
      localSpeaking: false,
      remoteSpeakingUserIds: new Set(),
      speakingUserIds: new Set(),
      remoteAudioDecoderSinks: new Map(),
      unsubscribeListenerSettings: () => undefined,
    }
    active.unsubscribeListenerSettings = voiceListenerStore.subscribe(() => {
      if (this.active !== active || !this.desired) return
      void active.audioMixer.applyVolumes(
        this.desired.userDeafened || this.desired.serverDeafened,
        this.desired.outputVolume,
      ).catch(() => undefined)
    })
    this.active = active
    this.attachRoomEvents(active)

    try {
      await raceWithAbort(
        room.connect(lease.credential.url, lease.credential.token),
        signal,
      )
      this.assertCurrent(active)
      if (signal.aborted) throw abortError()
      active.connected = true
      this.emitRoom(room)
      this.requestMediaReconcile()
    } catch (error) {
      if (this.active === active) this.active = null
      active.intentionalDisconnect = true
      this.clearRemoteAudio(active)
      room.removeAllListeners()
      await room.disconnect().catch(() => undefined)
      this.emitRoom(null)
      throw error
    }
  }

  async disconnect(_cause: VoiceDisconnectCause) {
    const active = this.active
    this.active = null
    this.mediaRevision += 1
    if (!active) return
    active.intentionalDisconnect = true
    this.clearRemoteAudio(active)
    active.room.removeAllListeners()
    await active.room.disconnect().catch(() => undefined)
    this.emitRoom(null)
  }

  updateDesiredMedia(desired: VoiceMediaDesiredState) {
    this.desired = desired
    this.requestMediaReconcile()
  }

  updateRemoteAudioSettings() {
    // The browser mixer consumes the same renderer-local listener store
    // directly; only the isolated native runtime needs an explicit bridge.
  }

  retryMedia(_kind: VoiceMediaKind) {
    const active = this.active
    if (active) {
      switch (_kind) {
        case 'microphone':
          active.appliedMicrophoneKey = null
          break
        case 'camera':
          active.appliedCameraKey = null
          break
        case 'screen':
        case 'screen_audio':
          active.appliedScreenKey = null
          break
        case 'output':
          active.appliedOutputKey = null
          break
      }
    }
    this.requestMediaReconcile()
  }

  subscribe(listener: (event: VoiceEngineEvent) => void) {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  subscribeRoom(listener: (room: Room | null) => void) {
    this.roomListeners.add(listener)
    listener(this.active?.room ?? null)
    return () => this.roomListeners.delete(listener)
  }

  room() {
    return this.active?.room ?? null
  }

  async dispose() {
    if (this.disposed) return
    this.disposed = true
    await this.disconnect('shutdown')
    this.listeners.clear()
    this.roomListeners.clear()
  }

  private attachRoomEvents(active: ActiveBrowserVoice) {
    const { room } = active
    room.on(
      RoomEvent.TrackPublished,
      (publication: RemoteTrackPublication) => {
        if (this.active !== active) return
        applyStageScreenPublicationSubscription(publication, false)
      },
    )
    room.on(RoomEvent.Reconnecting, () => {
      if (this.active !== active) return
      active.connected = false
      this.emitFor(active, { type: 'transientReconnectStarted' })
    })
    room.on(RoomEvent.Reconnected, () => {
      if (this.active !== active) return
      active.connected = true
      this.emitFor(active, { type: 'transientReconnectSucceeded' })
      this.requestMediaReconcile()
    })
    room.on(RoomEvent.Disconnected, (reason?: DisconnectReason) => {
      if (this.active !== active || active.intentionalDisconnect) return
      active.connected = false
      this.emitFor(active, {
        type: 'terminalFailure',
        failure: {
          code: browserDisconnectCode(reason),
          message: 'Browser voice connection ended',
          retryable: reason !== DisconnectReason.PARTICIPANT_REMOVED,
          stage: 'livekit_room',
        },
      })
    })
    room.on(
      RoomEvent.TrackSubscribed,
      (
        track,
        publication: RemoteTrackPublication,
        participant: RemoteParticipant,
      ) => {
        if (this.active !== active || track.kind !== Track.Kind.Audio) return
        const mediaStreamTrack = (
          track as typeof track & { mediaStreamTrack?: MediaStreamTrack }
        ).mediaStreamTrack
        if (!mediaStreamTrack) {
          this.emitMediaFailure(
            active,
            'output',
            new Error('Remote audio track has no MediaStreamTrack'),
          )
          return
        }
        try {
          this.replaceRemoteAudioDecoderSink(
            active,
            publication.trackSid,
            track,
          )
        } catch (error) {
          this.emitMediaFailure(active, 'output', error)
          return
        }
        const added = active.audioMixer.addTrack({
          trackId: publication.trackSid,
          userId: baseVoiceIdentity(participant.identity),
          source: remoteAudioSource(publication),
          mediaStreamTrack,
        })
        if (!added) {
          this.removeRemoteAudioDecoderSink(
            active,
            publication.trackSid,
            track,
          )
          this.emitMediaFailure(
            active,
            'output',
            new Error('Remote audio mixer is unavailable'),
          )
          return
        }
        const desired = this.desired
        if (desired) {
          void active.audioMixer.applyVolumes(
            desired.userDeafened || desired.serverDeafened,
            desired.outputVolume,
          ).catch(() => undefined)
        }
      },
    )
    room.on(
      RoomEvent.TrackUnsubscribed,
      (track, publication: RemoteTrackPublication) => {
        if (this.active !== active) return
        const sink = active.remoteAudioDecoderSinks.get(publication.trackSid)
        if (!sink || sink.track !== track) return
        active.audioMixer.removeTrack(publication.trackSid)
        const mediaStreamTrack = (
          track as typeof track & { mediaStreamTrack?: MediaStreamTrack }
        ).mediaStreamTrack
        if (mediaStreamTrack) {
          active.audioMixer.removeMediaStreamTrack(mediaStreamTrack)
        }
        this.removeRemoteAudioDecoderSink(active, publication.trackSid, track)
      },
    )
  }

  private requestMediaReconcile() {
    this.mediaRevision += 1
    this.ensureMediaReconcile()
  }

  private ensureMediaReconcile() {
    if (
      this.mediaReconcile ||
      !this.active?.connected ||
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
      this.active?.connected &&
      this.desired &&
      handledRevision !== this.mediaRevision
    ) {
      handledRevision = this.mediaRevision
      const active = this.active
      const desired = this.desired
      await Promise.allSettled([
        this.applyMicrophone(active, desired),
        this.applyCamera(active, desired),
        this.applyScreen(active, desired),
        this.applyOutput(active, desired),
      ])
      this.mediaHandledRevision = handledRevision
    }
  }

  private async applyMicrophone(
    active: ActiveBrowserVoice,
    desired: VoiceMediaDesiredState,
  ) {
    const microphoneKey = JSON.stringify([
      desired.microphoneDeviceId ?? '',
      desired.effectiveMuted,
    ])
    const processingKey = JSON.stringify([
      desired.noiseSuppression,
      desired.echoCancellation,
      desired.inputVolume,
      desired.voiceGateEnabled,
      desired.voiceGateThresholdDb,
      desired.voiceGateAutoThreshold,
    ])
    if (
      this.active !== active ||
      active.microphoneStarting ||
      (
        active.appliedMicrophoneKey === microphoneKey &&
        active.appliedMicrophoneProcessingKey === processingKey
      )
    ) {
      return
    }
    active.microphoneStarting = true
    try {
      const trackStateChanged = active.appliedMicrophoneKey !== microphoneKey
      let publication = active.microphonePublication
      if (!publication) {
        this.emitMedia(active, 'microphone', { state: 'starting' })
        const created = await active.room.localParticipant.setMicrophoneEnabled(
          true,
          {
            ...voiceAudioProcessingConstraints(desired),
            deviceId: desired.microphoneDeviceId,
          },
          voiceMicPublishOptions(),
        )
        this.assertCurrent(active)
        if (!created) throw new Error('Microphone publication was not created')
        publication = created
        active.microphonePublication = created
        active.appliedMicrophoneDeviceId = desired.microphoneDeviceId ?? 'default'
      } else if (
        active.appliedMicrophoneDeviceId !==
        (desired.microphoneDeviceId ?? 'default')
      ) {
        await active.room.switchActiveDevice(
          'audioinput',
          desired.microphoneDeviceId ?? 'default',
        )
        this.assertCurrent(active)
        active.appliedMicrophoneDeviceId =
          desired.microphoneDeviceId ?? 'default'
      }

      if (active.appliedMicrophoneProcessingKey !== processingKey) {
        await applyMicProcessing(active.room.localParticipant, desired)
        this.assertCurrent(active)
        active.appliedMicrophoneProcessingKey = processingKey
      }

      if (trackStateChanged) {
        if (desired.effectiveMuted) await publication.mute()
        else await publication.unmute()
        this.assertCurrent(active)
        this.emitMedia(active, 'microphone', {
          state: desired.effectiveMuted ? 'muted' : 'running',
        })
        active.appliedMicrophoneKey = microphoneKey
      }

      this.syncLocalSpeaking(active, desired)
    } catch (error) {
      if (this.active === active) {
        this.emitMediaFailure(active, 'microphone', error)
      }
    } finally {
      active.microphoneStarting = false
    }
  }

  private async applyCamera(
    active: ActiveBrowserVoice,
    desired: VoiceMediaDesiredState,
  ) {
    const cameraKey = JSON.stringify([
      desired.cameraEnabled,
      desired.cameraDeviceId ?? '',
    ])
    if (active.appliedCameraKey === cameraKey) return
    try {
      this.emitMedia(active, 'camera', {
        state: desired.cameraEnabled ? 'starting' : 'off',
      })
      await active.room.localParticipant.setCameraEnabled(
        desired.cameraEnabled,
        desired.cameraDeviceId ? { deviceId: desired.cameraDeviceId } : undefined,
      )
      this.assertCurrent(active)
      this.emitMedia(active, 'camera', {
        state: desired.cameraEnabled ? 'running' : 'off',
      })
      active.appliedCameraKey = cameraKey
    } catch (error) {
      if (this.active === active) this.emitMediaFailure(active, 'camera', error)
    }
  }

  private async applyScreen(
    active: ActiveBrowserVoice,
    desired: VoiceMediaDesiredState,
  ) {
    const screenKey = JSON.stringify([
      desired.screenEnabled,
      desired.screenAudioEnabled,
      desired.screenWidth ?? 0,
      desired.screenHeight ?? 0,
      desired.screenFps ?? 0,
      desired.screenBitrate ?? 0,
      desired.screenAudioBitrate ?? 0,
    ])
    if (active.appliedScreenKey === screenKey) return
    try {
      this.emitMedia(active, 'screen', {
        state: desired.screenEnabled ? 'starting' : 'off',
      })
      const screenOptions = browserScreenShareOptions(desired)
      await active.room.localParticipant.setScreenShareEnabled(
        desired.screenEnabled,
        screenOptions.capture,
        screenOptions.publish,
      )
      this.assertCurrent(active)
      this.emitMedia(active, 'screen', {
        state: desired.screenEnabled ? 'running' : 'off',
      })
      this.emitMedia(active, 'screen_audio', {
        state:
          desired.screenEnabled && desired.screenAudioEnabled
            ? 'running'
            : 'off',
      })
      active.appliedScreenKey = screenKey
    } catch (error) {
      if (this.active === active) this.emitMediaFailure(active, 'screen', error)
    }
  }

  private async applyOutput(
    active: ActiveBrowserVoice,
    desired: VoiceMediaDesiredState,
  ) {
    const outputKey = JSON.stringify([
      desired.outputDeviceId ?? '',
      desired.userDeafened || desired.serverDeafened,
      desired.outputVolume,
    ])
    if (active.appliedOutputKey === outputKey) return
    try {
      const outputDeviceId = desired.outputDeviceId ?? 'default'
      await active.audioMixer.setOutputDevice(desired.outputDeviceId)
      active.appliedOutputDeviceId = outputDeviceId
      const muted = desired.userDeafened || desired.serverDeafened
      await active.audioMixer.applyVolumes(muted, desired.outputVolume)
      this.assertCurrent(active)
      this.emitMedia(active, 'output', {
        state: desired.userDeafened || desired.serverDeafened ? 'muted' : 'running',
      })
      active.appliedOutputKey = outputKey
    } catch (error) {
      if (this.active === active) await this.handleOutputFailure(active, error)
    }
  }

  private async handleOutputFailure(active: ActiveBrowserVoice, error: unknown) {
    if (this.active !== active || active.outputRecovering) return
    const desired = this.desired
    if (!desired) return
    active.outputRecovering = true
    try {
      if (desired.outputDeviceId) {
        await active.audioMixer.setOutputDevice(undefined)
        await active.audioMixer.applyVolumes(
          desired.userDeafened || desired.serverDeafened,
          desired.outputVolume,
        )
        this.assertCurrent(active)
        active.appliedOutputDeviceId = 'default'
        active.appliedOutputKey = JSON.stringify([
          desired.outputDeviceId,
          desired.userDeafened || desired.serverDeafened,
          desired.outputVolume,
        ])
        this.emitMedia(active, 'output', {
          state: desired.userDeafened || desired.serverDeafened ? 'muted' : 'running',
          error: {
            code: 'output_device_fallback',
            message: 'Selected audio output is unavailable; using system default',
            retryable: false,
          },
        })
        return
      }
      this.emitMediaFailure(active, 'output', error)
    } catch (fallbackError) {
      if (this.active === active) {
        this.emitMediaFailure(active, 'output', fallbackError)
      }
    } finally {
      active.outputRecovering = false
    }
  }

  private emitMedia(
    active: ActiveBrowserVoice,
    kind: VoiceMediaKind,
    media: VoiceMediaSnapshot,
  ) {
    this.emitFor(active, { type: 'mediaState', kind, media })
  }

  private emitMediaFailure(
    active: ActiveBrowserVoice,
    kind: VoiceMediaKind,
    error: unknown,
  ) {
    this.emitMedia(active, kind, {
      state: 'failed',
      error: {
        code: `${kind}_unavailable`,
        message: error instanceof Error ? error.message : `${kind} failed`,
        retryable: true,
      },
    })
  }

  private emitFor(
    active: ActiveBrowserVoice,
    event: ScopedVoiceEngineEvent,
  ) {
    this.emit({
      ...event,
      operationId: active.lease.operationId,
      connectionEpoch: active.lease.connectionEpoch,
    } as VoiceEngineEvent)
  }

  private emit(event: VoiceEngineEvent) {
    for (const listener of this.listeners) listener(event)
  }

  private emitRoom(room: Room | null) {
    for (const listener of this.roomListeners) listener(room)
  }

  private clearRemoteAudio(active: ActiveBrowserVoice) {
    active.unsubscribeListenerSettings()
    active.localSpeakingDetector.dispose()
    for (const trackSid of [...active.remoteAudioDecoderSinks.keys()]) {
      this.removeRemoteAudioDecoderSink(active, trackSid)
    }
    active.audioMixer.dispose()
  }

  private syncLocalSpeaking(
    active: ActiveBrowserVoice,
    desired: VoiceMediaDesiredState,
  ) {
    const publication = active.room.localParticipant.getTrackPublication?.(
      Track.Source.Microphone,
    )
    const audioTrack = publication?.audioTrack as LocalAudioTrackWithProcessor | undefined
    const track = localMicMediaStreamTrack(audioTrack)
    active.localSpeakingDetector.setTrack(track)
    active.localSpeakingDetector.setEnabled(
      Boolean(track && !desired.effectiveMuted),
    )
    if (!track || desired.effectiveMuted) {
      active.localSpeaking = false
    }
  }

  private replaceRemoteAudioDecoderSink(
    active: ActiveBrowserVoice,
    trackSid: string,
    track: Track,
  ) {
    this.removeRemoteAudioDecoderSink(active, trackSid)
    track.detach().forEach((element) => element.remove())

    const element = track.attach() as HTMLAudioElement
    element.dataset.syrnikeRemoteAudioDecoder = trackSid
    element.autoplay = true
    element.muted = true
    element.volume = 0
    element.style.display = 'none'
    document.body.appendChild(element)
    active.remoteAudioDecoderSinks.set(trackSid, { track, element })

    void element.play().catch(() => undefined)
  }

  private removeRemoteAudioDecoderSink(
    active: ActiveBrowserVoice,
    trackSid: string,
    expectedTrack?: Track,
  ) {
    const sink = active.remoteAudioDecoderSinks.get(trackSid)
    if (!sink) return
    if (expectedTrack && sink.track !== expectedTrack) return
    active.remoteAudioDecoderSinks.delete(trackSid)
    const detached = sink.track.detach(sink.element)
    detached.pause()
    detached.srcObject = null
    detached.remove()
  }

  private assertCurrent(active: ActiveBrowserVoice) {
    if (this.active !== active) throw abortError()
  }
}

function remoteAudioSource(
  publication: RemoteTrackPublication,
): RemoteAudioSource {
  return publication.source === Track.Source.ScreenShareAudio ? 'stream' : 'mic'
}

type LocalAudioTrackWithProcessor = {
  mediaStreamTrack?: MediaStreamTrack
  getProcessor?: () => {
    name?: string
    processedTrack?: MediaStreamTrack
  } | undefined
}

function localMicMediaStreamTrack(
  track: LocalAudioTrackWithProcessor | undefined,
) {
  const processor = track?.getProcessor?.()
  return processor?.processedTrack ?? track?.mediaStreamTrack ?? null
}

function sameStringSet(left: ReadonlySet<string>, right: ReadonlySet<string>) {
  if (left.size !== right.size) return false
  for (const value of left) {
    if (!right.has(value)) return false
  }
  return true
}

function browserScreenShareOptions(desired: VoiceMediaDesiredState) {
  const width = desired.screenWidth ?? 1_920
  const height = desired.screenHeight ?? 1_080
  const fps = desired.screenFps ?? 30
  const bitrate = desired.screenBitrate ?? 6_000_000
  const audioBitrateKbps = Math.round(
    (desired.screenAudioBitrate ?? 128_000) / 1_000,
  )
  const quality = fps >= 50 ? 'high60' : width <= 1_280 ? 'low' : 'high'
  const publish = screenShareCombinedPublishOptions(quality, audioBitrateKbps, {
    maxWidth: width,
    maxHeight: height,
    maxFramerate: fps,
    maxBitrate: bitrate,
  })
  return {
    capture: {
      resolution: { width, height, frameRate: fps },
      audio: screenShareAudioCaptureOptions(desired.screenAudioEnabled),
      contentHint: fps <= 10 ? ('text' as const) : ('motion' as const),
    },
    publish: {
      ...publish,
      screenShareEncoding: {
        ...publish.screenShareEncoding,
        maxBitrate: bitrate,
        maxFramerate: fps,
        priority: 'high' as const,
      },
    },
  }
}

function browserDisconnectCode(reason?: DisconnectReason) {
  return reason === DisconnectReason.PARTICIPANT_REMOVED
    ? 'participant_removed'
    : 'browser_rtc_disconnected'
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
  return new DOMException('Browser RTC operation superseded', 'AbortError')
}
