import {
  RoomEvent,
  Track,
  type RemoteParticipant,
  type RemoteTrackPublication,
  type Room,
} from 'livekit-client'

import type { LocalSpeakingDetector } from '#/features/voice/local-speaking-detector'
import {
  baseVoiceIdentity,
  isDesktopNativeVoiceIdentity,
} from '#/features/voice/native-voice-identity'
import { SYRNIKE_MIC_PROCESSOR_NAME } from '#/features/voice/voice-mic-processor'
import type {
  RemoteAudioMixer,
  RemoteAudioSource,
} from '#/features/voice/remote-audio-mixer'

export type AudioTrackWithMedia = Track & {
  mediaStreamTrack?: MediaStreamTrack
  sid?: string
}

type RemoteTrackPublicationWithLegacySid = RemoteTrackPublication & {
  sid?: string
}

export type LocalAudioTrackWithProcessor = AudioTrackWithMedia & {
  getProcessor?: () =>
    | {
        name?: string
        processedTrack?: MediaStreamTrack
      }
    | undefined
}

export type VoiceRoomAudioCleanupDeps = {
  getRemoteAudioMixer: () => Pick<RemoteAudioMixer, 'clear'> | null
  getLocalSpeakingDetector: () => Pick<LocalSpeakingDetector, 'clear'> | null
  setSelfSpeaking: (speaking: boolean) => void
}

export type ApplyRemoteAudioDeps = {
  getRemoteAudioMixer: () => Pick<RemoteAudioMixer, 'applyVolumes'> | null
  isDeafened: () => boolean
}

export type PlayRemoteAudioTrackDeps = {
  currentUserId: string | null | undefined
  getRemoteAudioMixer: () => Pick<RemoteAudioMixer, 'addTrack'> | null
  applyRemoteAudio: () => void
  logError?: typeof console.error
}

export type CleanupRemoteAudioTrackSubscriptionDeps = {
  getRemoteAudioMixer: () => Pick<
    RemoteAudioMixer,
    'removeTrack' | 'removeMediaStreamTrack'
  > | null
}

export type NativeScreenStateForRoomAudio =
  | { status: 'published'; participantIdentity: string; publicationSid: string }
  | { status: string; participantIdentity?: string; publicationSid?: string }

export type AttachRoomAudioDeps = {
  currentUserId: string | null | undefined
  getRemoteAudioMixer: () => Pick<
    RemoteAudioMixer,
    'addTrack' | 'removeTrack' | 'removeMediaStreamTrack' | 'applyVolumes'
  > | null
  getDeafened: () => boolean
  getNativeScreenState: () => NativeScreenStateForRoomAudio
  getStoppedNativeScreenIdentity: () => string | null
  getCurrentRoom: () => Room | null
  getTargetChannelId: () => string | null
  markConnected: () => void
  setParticipantCount: (count: number) => void
  syncRoomParticipants: () => void
  runVoiceRecovery: (trigger: string) => void
  syncLocalSpeakingTrack: (room: Room) => void
  applyRemoteScreenParticipantSubscription: (
    participant: RemoteParticipant,
  ) => boolean
  syncMicFromRoom: (room: Room, issue?: unknown) => void
  abortJoinAttempt: () => void
  onNativeScreenPublicationLost: (loss: {
    reason: 'participant-disconnected' | 'track-unpublished'
    participantIdentity: string
    publicationSid?: string
    remoteParticipants?: number
  }) => void
  onUnexpectedRoomDisconnect: (targetChannelId: string) => void
  playUiSound: (sound: 'voice.user_join') => void
  describeMicDeviceError?: (error: unknown) => unknown
}

export function audioSourceFromPublication(
  publication: RemoteTrackPublication,
): RemoteAudioSource {
  return publication.source === Track.Source.ScreenShareAudio ? 'stream' : 'mic'
}

export function localMicMediaStreamTrack(
  track: LocalAudioTrackWithProcessor | undefined,
) {
  const processor = track?.getProcessor?.()
  if (
    processor?.name === SYRNIKE_MIC_PROCESSOR_NAME &&
    processor.processedTrack
  ) {
    return processor.processedTrack
  }
  return track?.mediaStreamTrack ?? null
}

export function remoteAudioTrackId(
  track: Track,
  publication: RemoteTrackPublication,
) {
  const audioTrack = track as AudioTrackWithMedia
  return (
    publication.trackSid ??
    audioTrack.sid ??
    audioTrack.mediaStreamTrack?.id ??
    crypto.randomUUID()
  )
}

export function cleanupVoiceRoomAudio(deps: VoiceRoomAudioCleanupDeps) {
  deps.getRemoteAudioMixer()?.clear()
  deps.getLocalSpeakingDetector()?.clear()
  deps.setSelfSpeaking(false)
  document
    .querySelectorAll('audio[data-syrnike-remote-audio-mixer="source"]')
    .forEach((element) => element.remove())
}

export function applyRemoteAudio(deps: ApplyRemoteAudioDeps) {
  deps.getRemoteAudioMixer()?.applyVolumes(deps.isDeafened())
}

export function playRemoteAudioTrack(
  track: Track,
  publication: RemoteTrackPublication,
  participant: RemoteParticipant,
  deps: PlayRemoteAudioTrackDeps,
) {
  if (track.kind !== Track.Kind.Audio) return

  const removeDetachedElement = (element: Element) => {
    element.remove()
  }
  if (
    isDesktopNativeVoiceIdentity(participant.identity) &&
    baseVoiceIdentity(participant.identity) === deps.currentUserId
  ) {
    track.detach().forEach(removeDetachedElement)
    return
  }

  const audioTrack = track as AudioTrackWithMedia
  track.detach().forEach(removeDetachedElement)
  const sourceElement = track.attach() as HTMLAudioElement
  sourceElement.dataset.syrnikeRemoteAudioMixer = 'source'
  sourceElement.muted = true
  sourceElement.volume = 0
  sourceElement.autoplay = true
  sourceElement.style.display = 'none'
  document.body.appendChild(sourceElement)
  const playPromise = sourceElement.play()
  void playPromise?.catch?.(() => {})

  const mediaStreamTrack = audioTrack.mediaStreamTrack
  const logError = deps.logError ?? console.error
  if (!mediaStreamTrack) {
    logError('[voice-audio-mixer] missing remote audio media track', {
      userId: baseVoiceIdentity(participant.identity),
      publicationTrackSid: publication.trackSid,
    })
    return
  }

  const added = deps.getRemoteAudioMixer()?.addTrack({
    trackId: remoteAudioTrackId(track, publication),
    userId: baseVoiceIdentity(participant.identity),
    source: audioSourceFromPublication(publication),
    mediaStreamTrack,
  })
  if (!added) {
    logError('[voice-audio-mixer] failed to add remote audio track', {
      userId: baseVoiceIdentity(participant.identity),
      publicationTrackSid: publication.trackSid,
      mediaStreamTrackId: mediaStreamTrack.id,
    })
  }
  deps.applyRemoteAudio()
}

export function cleanupRemoteAudioTrackSubscription(
  track: Track,
  publication: RemoteTrackPublication,
  deps: CleanupRemoteAudioTrackSubscriptionDeps,
) {
  if (track.kind === Track.Kind.Audio) {
    deps.getRemoteAudioMixer()?.removeTrack(remoteAudioTrackId(track, publication))
    const mediaStreamTrack = (track as AudioTrackWithMedia).mediaStreamTrack
    if (mediaStreamTrack) {
      deps.getRemoteAudioMixer()?.removeMediaStreamTrack(mediaStreamTrack)
    }
  }
  track.detach().forEach((element) => element.remove())
}

function remotePublicationSid(publication: RemoteTrackPublication) {
  return (
    publication.trackSid ||
    (publication as RemoteTrackPublicationWithLegacySid).sid
  )
}

function isCurrentNativeScreenParticipant(
  screen: NativeScreenStateForRoomAudio,
  participantIdentity: string,
) {
  return (
    screen.status === 'published' &&
    screen.participantIdentity === participantIdentity
  )
}

function isCurrentNativeScreenPublication(
  screen: NativeScreenStateForRoomAudio,
  participantIdentity: string,
  publication: RemoteTrackPublication,
) {
  if (!isCurrentNativeScreenParticipant(screen, participantIdentity)) {
    return false
  }
  return remotePublicationSid(publication) === screen.publicationSid
}

export function attachRoomAudio(room: Room, deps: AttachRoomAudioDeps) {
  const removeDetachedElement = (element: Element) => {
    element.remove()
  }

  const playTrack = (
    track: Track,
    publication: RemoteTrackPublication,
    participant: RemoteParticipant,
  ) => {
    playRemoteAudioTrack(track, publication, participant, {
      currentUserId: deps.currentUserId,
      getRemoteAudioMixer: deps.getRemoteAudioMixer,
      applyRemoteAudio: () =>
        deps.getRemoteAudioMixer()?.applyVolumes(deps.getDeafened()),
    })
  }

  const onParticipantsChanged = () => {
    deps.setParticipantCount(room.numParticipants)
    deps.syncRoomParticipants()
    deps.runVoiceRecovery('participants_changed')
  }
  const onLocalParticipantsChanged = () => {
    deps.syncLocalSpeakingTrack(room)
    onParticipantsChanged()
  }
  const onRemoteParticipantDisconnected = (
    participant: RemoteParticipant,
  ) => {
    const screen = deps.getNativeScreenState()
    if (
      deps.getStoppedNativeScreenIdentity() !== participant.identity &&
      isCurrentNativeScreenParticipant(screen, participant.identity)
    ) {
      deps.onNativeScreenPublicationLost({
        reason: 'participant-disconnected',
        participantIdentity: participant.identity,
        publicationSid: screen.publicationSid,
        remoteParticipants: room.remoteParticipants.size,
      })
    }
    onParticipantsChanged()
  }
  const onRemoteTrackUnpublished = (
    publication: RemoteTrackPublication,
    participant: RemoteParticipant,
  ) => {
    const screen = deps.getNativeScreenState()
    if (
      deps.getStoppedNativeScreenIdentity() !== participant.identity &&
      publication.source === Track.Source.ScreenShare &&
      isCurrentNativeScreenPublication(
        screen,
        participant.identity,
        publication,
      )
    ) {
      deps.onNativeScreenPublicationLost({
        reason: 'track-unpublished',
        participantIdentity: participant.identity,
        publicationSid: remotePublicationSid(publication),
        remoteParticipants: room.remoteParticipants.size,
      })
    }
    onParticipantsChanged()
  }

  room.on(RoomEvent.TrackSubscribed, (track, publication, participant) => {
    if (participant.isLocal) return
    if (
      publication.source === Track.Source.ScreenShare ||
      publication.source === Track.Source.ScreenShareAudio
    ) {
      const subscribed = deps.applyRemoteScreenParticipantSubscription(participant)
      if (!subscribed) {
        publication.setSubscribed?.(false)
        track.detach().forEach(removeDetachedElement)
        onParticipantsChanged()
        return
      }
    }
    if (track.kind === Track.Kind.Audio) {
      playTrack(track, publication, participant)
      return
    }
    onParticipantsChanged()
  })

  room.on(RoomEvent.TrackUnsubscribed, (track, publication) => {
    cleanupRemoteAudioTrackSubscription(track, publication, {
      getRemoteAudioMixer: deps.getRemoteAudioMixer,
    })
    onParticipantsChanged()
  })

  room.on(RoomEvent.ParticipantConnected, onParticipantsChanged)
  room.on(RoomEvent.ParticipantDisconnected, onRemoteParticipantDisconnected)
  room.on(RoomEvent.LocalTrackPublished, onLocalParticipantsChanged)
  room.on(RoomEvent.LocalTrackUnpublished, onLocalParticipantsChanged)
  room.on(RoomEvent.TrackPublished, (_publication, participant) => {
    if (!participant.isLocal) {
      deps.applyRemoteScreenParticipantSubscription(participant)
    }
    onParticipantsChanged()
  })
  room.on(RoomEvent.TrackUnpublished, onRemoteTrackUnpublished)
  room.on(RoomEvent.TrackMuted, (_publication, participant) => {
    if (participant.isLocal) {
      deps.syncLocalSpeakingTrack(room)
    }
    onParticipantsChanged()
  })
  room.on(RoomEvent.TrackUnmuted, (_publication, participant) => {
    if (participant.isLocal) {
      deps.syncLocalSpeakingTrack(room)
    }
    onParticipantsChanged()
  })

  room.on(RoomEvent.Connected, () => {
    if (!deps.getTargetChannelId()) return
    deps.markConnected()
    deps.playUiSound('voice.user_join')
    onParticipantsChanged()
  })

  room.on(RoomEvent.MediaDevicesError, (error, kind) => {
    if (kind !== 'audioinput') return
    deps.syncMicFromRoom(room, deps.describeMicDeviceError?.(error) ?? error)
  })

  room.on(RoomEvent.Disconnected, () => {
    if (deps.getCurrentRoom() !== room) {
      room.removeAllListeners()
      return
    }

    const targetChannelId = deps.getTargetChannelId()
    if (!targetChannelId) {
      deps.abortJoinAttempt()
      return
    }

    deps.onUnexpectedRoomDisconnect(targetChannelId)
  })

  onParticipantsChanged()
}
