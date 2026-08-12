import {
  DisconnectReason,
  Room,
  RoomEvent,
  Track,
  type RemoteParticipant,
  type RemoteTrackPublication,
  type LocalTrackPublication,
} from 'livekit-client'
import { Effect, Exit, Fiber, Layer, ManagedRuntime } from 'effect'
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
import { applyMicProcessingEffect } from '#/features/voice/voice-mic-processing'
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
  private readonly effectRuntime = ManagedRuntime.make(Layer.empty)
  private active: ActiveBrowserVoice | null = null
  private desired: VoiceMediaDesiredState | null = null
  private mediaRevision = 0
  private mediaHandledRevision = 0
  private mediaReconcile: Fiber.Fiber<void, never> | null = null
  private disposed = false

  connect(
    lease: VoiceLease,
    desired: VoiceMediaDesiredState,
    signal: AbortSignal,
  ) {
    return this.effectRuntime.runPromise(
      this.connectEffect(lease, desired).pipe(
        Effect.raceFirst(abortSignal(signal)),
      ),
    )
  }

  private connectEffect(
    lease: VoiceLease,
    desired: VoiceMediaDesiredState,
  ) {
    return Effect.suspend(() => {
      if (this.disposed) {
        return Effect.fail(new Error('Browser RTC adapter is disposed'))
      }
      if (lease.rtcEngine !== 'web') {
        return Effect.fail(
          new Error('Browser RTC adapter received a non-web Voice Lease'),
        )
      }
      if (this.active) {
        return Effect.fail(new Error('Browser RTC adapter already owns a Room'))
      }

      this.desired = desired
      const room = new Room(createVoiceRoomOptions())
      let active: ActiveBrowserVoice | null = null
      const publishSpeaking = () => {
        if (!active || this.active !== active) return
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
          if (!active || this.active !== active) return
          active.localSpeaking = speaking
          publishSpeaking()
        },
      })
      const audioMixer = createRemoteAudioMixer({
        onOutputError: (error) => {
          if (!active || this.active !== active) return
          this.effectRuntime.runFork(
            this.handleOutputFailureEffect(active, error),
          )
        },
        onSpeakingUserIdsChange: (userIds) => {
          if (!active || this.active !== active) return
          active.remoteSpeakingUserIds = new Set(userIds)
          publishSpeaking()
        },
      })
      const owned: ActiveBrowserVoice = {
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
      active = owned
      owned.unsubscribeListenerSettings = voiceListenerStore.subscribe(() => {
        if (this.active !== owned || !this.desired) return
        this.applyRemoteAudioVolumes(owned, this.desired)
      })
      this.active = owned
      this.attachRoomEvents(owned)

      const cleanup = Effect.gen({ self: this }, function*() {
        if (this.active === owned) this.active = null
        owned.intentionalDisconnect = true
        this.clearRemoteAudio(owned)
        room.removeAllListeners()
        yield* promiseEffect(() => room.disconnect()).pipe(Effect.ignore)
        this.emitRoom(null)
      })
      return Effect.gen({ self: this }, function*() {
        yield* promiseEffect(() =>
          room.connect(lease.credential.url, lease.credential.token)
        )
        yield* this.assertCurrentEffect(owned)
        owned.connected = true
        this.emitRoom(room)
        this.requestMediaReconcile()
      }).pipe(
        Effect.onExit((exit) =>
          Exit.isFailure(exit) ? cleanup : Effect.void,
        ),
      )
    })
  }

  disconnect(_cause: VoiceDisconnectCause) {
    return this.effectRuntime.runPromise(this.disconnectEffect())
  }

  private disconnectEffect() {
    return Effect.gen({ self: this }, function*() {
      const active = this.active
      this.active = null
      this.mediaRevision += 1
      if (!active) return
      active.intentionalDisconnect = true
      this.clearRemoteAudio(active)
      active.room.removeAllListeners()
      yield* promiseEffect(() => active.room.disconnect()).pipe(Effect.ignore)
      this.emitRoom(null)
    })
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

  dispose() {
    return Effect.runPromise(
      this.disposeEffect().pipe(
        Effect.andThen(
          this.effectRuntime.disposeEffect,
        ),
      ),
    )
  }

  disposeEffect() {
    return Effect.gen({ self: this }, function*() {
      if (this.disposed) return
      this.disposed = true
      yield* this.disconnectEffect()
      this.listeners.clear()
      this.roomListeners.clear()
    })
  }

  private attachRoomEvents(active: ActiveBrowserVoice) {
    const { room } = active
    room.on(
      RoomEvent.LocalTrackUnpublished,
      (publication: LocalTrackPublication) => {
        if (
          this.active !== active ||
          publication.source !== Track.Source.Microphone ||
          active.microphonePublication?.trackSid !== publication.trackSid
        ) {
          return
        }
        active.microphonePublication = null
        active.appliedMicrophoneKey = null
        active.appliedMicrophoneDeviceId = null
        active.appliedMicrophoneProcessingKey = null
        active.localSpeakingDetector.clear()
        active.localSpeaking = false
        if (!this.desired?.serverMuted) this.requestMediaReconcile()
      },
    )
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
          this.applyRemoteAudioVolumes(active, desired)
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
    let fiber: Fiber.Fiber<void, never>
    const reconcile = this.reconcileMediaLoop().pipe(
      Effect.ensuring(
        Effect.sync(() => {
          if (this.mediaReconcile === fiber) {
            this.mediaReconcile = null
          }
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
    fiber = this.effectRuntime.runFork(reconcile)
    this.mediaReconcile = fiber
  }

  private reconcileMediaLoop() {
    return Effect.gen({ self: this }, function*() {
      let handledRevision = -1
      while (
        this.active?.connected &&
        this.desired &&
        handledRevision !== this.mediaRevision
      ) {
        handledRevision = this.mediaRevision
        const active = this.active
        const desired = this.desired
        yield* Effect.all(
          [
            this.applyMicrophoneEffect(active, desired),
            this.applyCameraEffect(active, desired),
            this.applyScreenEffect(active, desired),
            this.applyOutputEffect(active, desired),
          ],
          { concurrency: 'unbounded', discard: true },
        )
        this.mediaHandledRevision = handledRevision
      }
    })
  }

  private applyMicrophoneEffect(
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
      return Effect.void
    }
    active.microphoneStarting = true
    return Effect.gen({ self: this }, function*() {
      const trackStateChanged = active.appliedMicrophoneKey !== microphoneKey
      let publication = active.microphonePublication
      if (!publication) {
        if (desired.serverMuted) {
          this.emitMedia(active, 'microphone', { state: 'muted' })
          this.syncLocalSpeaking(active, desired)
          return
        }
        this.emitMedia(active, 'microphone', { state: 'starting' })
        const created = yield* promiseEffect(() =>
          active.room.localParticipant.setMicrophoneEnabled(
            true,
            {
              ...voiceAudioProcessingConstraints(desired),
              deviceId: desired.microphoneDeviceId,
            },
            voiceMicPublishOptions(),
          )
        )
        yield* this.assertCurrentEffect(active)
        if (!created) {
          return yield* Effect.fail(
            new Error('Microphone publication was not created'),
          )
        }
        publication = created
        active.microphonePublication = created
        active.appliedMicrophoneDeviceId = desired.microphoneDeviceId ?? 'default'
      } else if (
        active.appliedMicrophoneDeviceId !==
        (desired.microphoneDeviceId ?? 'default')
      ) {
        yield* promiseEffect(() =>
          active.room.switchActiveDevice(
            'audioinput',
            desired.microphoneDeviceId ?? 'default',
          )
        )
        yield* this.assertCurrentEffect(active)
        active.appliedMicrophoneDeviceId =
          desired.microphoneDeviceId ?? 'default'
      }

      if (active.appliedMicrophoneProcessingKey !== processingKey) {
        yield* applyMicProcessingEffect(
          active.room.localParticipant,
          desired,
        )
        yield* this.assertCurrentEffect(active)
        active.appliedMicrophoneProcessingKey = processingKey
      }

      if (trackStateChanged) {
        yield* promiseEffect(() =>
          desired.effectiveMuted
            ? publication.mute()
            : publication.unmute()
        )
        yield* this.assertCurrentEffect(active)
        this.emitMedia(active, 'microphone', {
          state: desired.effectiveMuted ? 'muted' : 'running',
        })
        active.appliedMicrophoneKey = microphoneKey
      }

      this.syncLocalSpeaking(active, desired)
    }).pipe(
      Effect.catch((error) =>
        Effect.sync(() => {
          if (this.active === active) {
            this.emitMediaFailure(active, 'microphone', error)
          }
        }),
      ),
      Effect.ensuring(
        Effect.sync(() => {
          active.microphoneStarting = false
        }),
      ),
    )
  }

  private applyCameraEffect(
    active: ActiveBrowserVoice,
    desired: VoiceMediaDesiredState,
  ) {
    const cameraKey = JSON.stringify([
      desired.cameraEnabled,
      desired.cameraDeviceId ?? '',
    ])
    if (active.appliedCameraKey === cameraKey) return Effect.void
    return Effect.gen({ self: this }, function*() {
      this.emitMedia(active, 'camera', {
        state: desired.cameraEnabled ? 'starting' : 'off',
      })
      yield* promiseEffect(() =>
        active.room.localParticipant.setCameraEnabled(
          desired.cameraEnabled,
          desired.cameraDeviceId
            ? { deviceId: desired.cameraDeviceId }
            : undefined,
        )
      )
      yield* this.assertCurrentEffect(active)
      this.emitMedia(active, 'camera', {
        state: desired.cameraEnabled ? 'running' : 'off',
      })
      active.appliedCameraKey = cameraKey
    }).pipe(
      Effect.catch((error) =>
        Effect.sync(() => {
          if (this.active === active) {
            this.emitMediaFailure(active, 'camera', error)
          }
        }),
      ),
    )
  }

  private applyScreenEffect(
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
    if (active.appliedScreenKey === screenKey) return Effect.void
    return Effect.gen({ self: this }, function*() {
      this.emitMedia(active, 'screen', {
        state: desired.screenEnabled ? 'starting' : 'off',
      })
      const screenOptions = browserScreenShareOptions(desired)
      yield* promiseEffect(() =>
        active.room.localParticipant.setScreenShareEnabled(
          desired.screenEnabled,
          screenOptions.capture,
          screenOptions.publish,
        )
      )
      yield* this.assertCurrentEffect(active)
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
    }).pipe(
      Effect.catch((error) =>
        Effect.sync(() => {
          if (this.active === active) {
            this.emitMediaFailure(active, 'screen', error)
          }
        }),
      ),
    )
  }

  private applyOutputEffect(
    active: ActiveBrowserVoice,
    desired: VoiceMediaDesiredState,
  ) {
    const outputKey = JSON.stringify([
      desired.outputDeviceId ?? '',
      desired.userDeafened || desired.serverDeafened,
      desired.outputVolume,
    ])
    if (active.appliedOutputKey === outputKey) return Effect.void
    return Effect.gen({ self: this }, function*() {
      const outputDeviceId = desired.outputDeviceId ?? 'default'
      yield* active.audioMixer.setOutputDeviceEffect(desired.outputDeviceId)
      active.appliedOutputDeviceId = outputDeviceId
      const muted = desired.userDeafened || desired.serverDeafened
      yield* active.audioMixer.applyVolumesEffect(muted, desired.outputVolume)
      yield* this.assertCurrentEffect(active)
      this.emitMedia(active, 'output', {
        state: desired.userDeafened || desired.serverDeafened ? 'muted' : 'running',
      })
      active.appliedOutputKey = outputKey
    }).pipe(
      Effect.catch((error) =>
        this.active === active
          ? this.handleOutputFailureEffect(active, error)
          : Effect.void,
      ),
    )
  }

  private handleOutputFailureEffect(
    active: ActiveBrowserVoice,
    error: unknown,
  ) {
    if (this.active !== active || active.outputRecovering) return Effect.void
    const desired = this.desired
    if (!desired) return Effect.void
    active.outputRecovering = true
    return Effect.gen({ self: this }, function*() {
      if (desired.outputDeviceId) {
        yield* active.audioMixer.setOutputDeviceEffect(undefined)
        yield* active.audioMixer.applyVolumesEffect(
          desired.userDeafened || desired.serverDeafened,
          desired.outputVolume,
        )
        yield* this.assertCurrentEffect(active)
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
    }).pipe(
      Effect.catch((fallbackError) =>
        Effect.sync(() => {
          if (this.active === active) {
            this.emitMediaFailure(active, 'output', fallbackError)
          }
        }),
      ),
      Effect.ensuring(
        Effect.sync(() => {
          active.outputRecovering = false
        }),
      ),
    )
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

    this.effectRuntime.runFork(
      Effect.tryPromise({
        try: () => element.play(),
        catch: (cause) => cause,
      }).pipe(Effect.ignore),
    )
  }

  private applyRemoteAudioVolumes(
    active: ActiveBrowserVoice,
    desired: VoiceMediaDesiredState,
  ) {
    this.effectRuntime.runFork(
      active.audioMixer.applyVolumesEffect(
        desired.userDeafened || desired.serverDeafened,
        desired.outputVolume,
      ).pipe(Effect.ignore),
    )
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

  private assertCurrentEffect(active: ActiveBrowserVoice) {
    return Effect.try({
      try: () => this.assertCurrent(active),
      catch: (cause) => cause,
    })
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

function promiseEffect<A>(run: () => Promise<A>) {
  return Effect.tryPromise({
    try: run,
    catch: (cause) => cause,
  })
}

function abortError() {
  return new DOMException('Browser RTC operation superseded', 'AbortError')
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
