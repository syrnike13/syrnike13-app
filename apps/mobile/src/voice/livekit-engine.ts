import { AudioSession } from '@livekit/react-native'
import type {
  RtcEngineAdapter,
  VoiceDisconnectCause,
  VoiceEngineEvent,
  VoiceLease,
  VoiceMediaDesiredState,
  VoiceMediaKind,
  VoiceMediaSnapshot,
} from '@syrnike13/platform'
import { Room, RoomEvent, Track, type RemoteTrackPublication } from 'livekit-client'

type EngineEvent = VoiceEngineEvent extends infer Event
  ? Event extends { operationId: string }
    ? Omit<Event, 'operationId' | 'connectionEpoch'>
    : never
  : never

/** `voice:v1|engine|client|epoch|operation|userId` -> `userId`, as on web. */
function userIdFromIdentity(identity: string) {
  const parts = identity.split('|')
  return parts.length === 6 && parts[0] === 'voice:v1' ? parts[5]! : identity
}

/**
 * Voice engine on LiveKit's React Native SDK. Audio routing and processing are
 * left to Android's communication audio mode; the shared VoiceDirector owns
 * membership, retries and the authority protocol.
 */
export class LiveKitEngineAdapter implements RtcEngineAdapter {
  private room: Room | null = null
  private lease: VoiceLease | null = null
  private desired: VoiceMediaDesiredState | null = null
  private readonly listeners = new Set<(event: VoiceEngineEvent) => void>()

  async connect(lease: VoiceLease, desired: VoiceMediaDesiredState, signal: AbortSignal) {
    await this.closeRoom()
    this.lease = lease
    this.desired = desired
    await AudioSession.startAudioSession()

    const room = new Room({ adaptiveStream: true, dynacast: true })
    this.room = room
    room
      .on(RoomEvent.ActiveSpeakersChanged, (speakers) => {
        this.emit(room, {
          type: 'speakingChanged',
          participantIdentities: speakers.map((p) => userIdFromIdentity(p.identity)),
        })
      })
      .on(RoomEvent.Reconnecting, () => {
        this.emit(room, { type: 'transientReconnectStarted' })
      })
      .on(RoomEvent.Reconnected, () => {
        this.emit(room, { type: 'transientReconnectSucceeded' })
      })
      .on(RoomEvent.TrackSubscribed, (_track, publication) => {
        if (publication.kind === Track.Kind.Audio) this.applyDeafen(publication)
      })
      .on(RoomEvent.Disconnected, (reason) => {
        if (this.room !== room) return
        this.emit(room, {
          type: 'terminalFailure',
          failure: {
            code: 'livekit_disconnected',
            message: `LiveKit disconnected (${reason ?? 'unknown'})`,
            retryable: true,
          },
        })
      })

    const abort = () => void room.disconnect()
    signal.addEventListener('abort', abort)
    try {
      await room.connect(lease.credential.url, lease.credential.token)
    } finally {
      signal.removeEventListener('abort', abort)
    }
    if (signal.aborted) {
      await this.closeRoom()
      throw new DOMException('Voice connect aborted', 'AbortError')
    }
    await this.applyMedia()
  }

  async disconnect(_cause: VoiceDisconnectCause) {
    await this.closeRoom()
  }

  updateDesiredMedia(desired: VoiceMediaDesiredState) {
    this.desired = desired
    void this.applyMedia()
  }

  updateRemoteAudioSettings() {
    // Per-user volumes are not part of the prototype.
  }

  retryMedia() {
    void this.applyMedia()
  }

  subscribe(listener: (event: VoiceEngineEvent) => void) {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  private async applyMedia() {
    const room = this.room
    const desired = this.desired
    if (!room || !desired) return

    for (const participant of room.remoteParticipants.values()) {
      for (const publication of participant.audioTrackPublications.values()) {
        this.applyDeafen(publication)
      }
    }
    this.emitMedia(room, 'output', { state: desired.userDeafened ? 'muted' : 'running' })

    await this.applyTrack(room, 'microphone', !desired.effectiveMuted, () =>
      room.localParticipant.setMicrophoneEnabled(!desired.effectiveMuted),
    )
    await this.applyTrack(room, 'screen', desired.screenEnabled, () =>
      room.localParticipant.setScreenShareEnabled(desired.screenEnabled),
    )
  }

  private async applyTrack(
    room: Room,
    kind: VoiceMediaKind,
    enabled: boolean,
    apply: () => Promise<unknown>,
  ) {
    try {
      await apply()
      this.emitMedia(room, kind, { state: enabled ? 'running' : kind === 'microphone' ? 'muted' : 'off' })
    } catch (error) {
      this.emitMedia(room, kind, {
        state: 'failed',
        error: {
          code: `${kind}_failed`,
          message: error instanceof Error ? error.message : String(error),
          retryable: true,
        },
      })
    }
  }

  private applyDeafen(publication: RemoteTrackPublication) {
    publication.setEnabled(!this.desired?.userDeafened)
  }

  private async closeRoom() {
    const room = this.room
    this.room = null
    if (room) await room.disconnect()
    await AudioSession.stopAudioSession()
  }

  private emitMedia(room: Room, kind: VoiceMediaKind, media: VoiceMediaSnapshot) {
    this.emit(room, { type: 'mediaState', kind, media })
  }

  private emit(room: Room, event: EngineEvent) {
    const lease = this.lease
    if (this.room !== room || !lease) return
    const full = {
      ...event,
      operationId: lease.operationId,
      connectionEpoch: lease.connectionEpoch,
    } as VoiceEngineEvent
    for (const listener of this.listeners) listener(full)
  }
}
