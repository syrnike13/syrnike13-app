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
import {
  detectNativeScreenParticipantDisconnectLoss,
  detectNativeScreenTrackUnpublishedLoss,
  type NativeScreenPublicationLoss,
  type NativeScreenPublicationState,
} from '#/features/voice/native-screen-publication-loss'
import { SYRNIKE_MIC_PROCESSOR_NAME } from '#/features/voice/voice-mic-processor'
import type {
  RemoteAudioMixer,
  RemoteAudioSource,
} from '#/features/voice/remote-audio-mixer'

export type AudioTrackWithMedia = Track & {
  mediaStreamTrack?: MediaStreamTrack
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
  currentUserId: string | null
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

export type AttachRoomAudioDeps = {
  currentUserId: string | null
  getRemoteAudioMixer: () => Pick<
    RemoteAudioMixer,
    'addTrack' | 'removeTrack' | 'removeMediaStreamTrack' | 'applyVolumes'
  > | null
  getDeafened: () => boolean
  getNativeScreenState: () => NativeScreenPublicationState
  getStoppedNativeScreenIdentity: () => string | null
  isOwnedRoom: (room: Room) => boolean
  getTargetChannelId: () => string | null
  setParticipantCount: (count: number) => void
  syncRoomParticipants: () => void
  runVoiceRecovery: (trigger: string, sourceRoom: Room) => void
  syncLocalSpeakingTrack: (room: Room) => void
  applyRemoteScreenParticipantSubscription: (
    participant: RemoteParticipant,
  ) => boolean
  syncMicFromRoom: (room: Room, issue?: unknown) => void
  abortJoinAttempt: () => void
  onNativeScreenPublicationLost: (loss: NativeScreenPublicationLoss) => void
  onUnexpectedRoomDisconnect: (targetChannelId: string) => void
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

function removeDetachedElement(element: Element) {
  element.remove()
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
  if (track.kind !== Track.Kind.Audio) return null

  if (
    isDesktopNativeVoiceIdentity(participant.identity) &&
    baseVoiceIdentity(participant.identity) === deps.currentUserId
  ) {
    track.detach().forEach(removeDetachedElement)
    return null
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
    return null
  }

  const trackId = remoteAudioTrackId(track, publication)
  const added = deps.getRemoteAudioMixer()?.addTrack({
    trackId,
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
  return { trackId, mediaStreamTrack }
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

export function attachRoomAudio(room: Room, deps: AttachRoomAudioDeps) {
  const remoteAudioSubscriptions = new Map<
    Track,
    { trackId: string; mediaStreamTrack: MediaStreamTrack }
  >()
  const playTrack = (
    track: Track,
    publication: RemoteTrackPublication,
    participant: RemoteParticipant,
  ) => {
    const subscription = playRemoteAudioTrack(track, publication, participant, {
      currentUserId: deps.currentUserId,
      getRemoteAudioMixer: deps.getRemoteAudioMixer,
      applyRemoteAudio: () =>
        deps.getRemoteAudioMixer()?.applyVolumes(deps.getDeafened()),
    })
    if (subscription) {
      remoteAudioSubscriptions.set(track, subscription)
    }
  }

  const cleanupRemoteAudioSubscription = (
    track: Track,
    publication: RemoteTrackPublication,
  ) => {
    const subscription = remoteAudioSubscriptions.get(track)
    if (subscription) {
      deps.getRemoteAudioMixer()?.removeTrack(subscription.trackId)
      deps
        .getRemoteAudioMixer()
        ?.removeMediaStreamTrack(subscription.mediaStreamTrack)
      remoteAudioSubscriptions.delete(track)
      track.detach().forEach(removeDetachedElement)
      return
    }
    cleanupRemoteAudioTrackSubscription(track, publication, {
      getRemoteAudioMixer: deps.getRemoteAudioMixer,
    })
  }

  const cleanupRoomRemoteAudio = () => {
    for (const [track, subscription] of remoteAudioSubscriptions) {
      deps.getRemoteAudioMixer()?.removeTrack(subscription.trackId)
      deps
        .getRemoteAudioMixer()
        ?.removeMediaStreamTrack(subscription.mediaStreamTrack)
      track.detach().forEach(removeDetachedElement)
    }
    remoteAudioSubscriptions.clear()
  }

  const syncParticipants = () => {
    if (!deps.isOwnedRoom(room)) return
    deps.setParticipantCount(room.numParticipants)
    deps.syncRoomParticipants()
  }
  const onParticipantsChanged = () => {
    syncParticipants()
    deps.runVoiceRecovery('participants_changed', room)
  }
  const onLocalParticipantsChanged = () => {
    deps.syncLocalSpeakingTrack(room)
    onParticipantsChanged()
  }
  const onRemoteParticipantDisconnected = (
    participant: RemoteParticipant,
  ) => {
    const loss = detectNativeScreenParticipantDisconnectLoss({
      screen: deps.getNativeScreenState(),
      stoppedNativeScreenIdentity: deps.getStoppedNativeScreenIdentity(),
      remoteParticipants: room.remoteParticipants.size,
      participantIdentity: participant.identity,
    })
    if (loss) {
      deps.onNativeScreenPublicationLost(loss)
    }
    onParticipantsChanged()
  }
  const onRemoteTrackUnpublished = (
    publication: RemoteTrackPublication,
    participant: RemoteParticipant,
  ) => {
    const loss = detectNativeScreenTrackUnpublishedLoss({
      screen: deps.getNativeScreenState(),
      stoppedNativeScreenIdentity: deps.getStoppedNativeScreenIdentity(),
      remoteParticipants: room.remoteParticipants.size,
      participantIdentity: participant.identity,
      publication,
    })
    if (loss) {
      deps.onNativeScreenPublicationLost(loss)
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
    cleanupRemoteAudioSubscription(track, publication)
    onParticipantsChanged()
  })

  room.on(RoomEvent.ParticipantConnected, onParticipantsChanged)
  room.on(RoomEvent.ParticipantDisconnected, onRemoteParticipantDisconnected)
  room.on(RoomEvent.LocalTrackPublished, onLocalParticipantsChanged)
  room.on(RoomEvent.LocalTrackUnpublished, onLocalParticipantsChanged)
  room.on(RoomEvent.TrackPublished, (publication, participant) => {
    // Подписочная логика экрана относится только к screen-share-трекам;
    // для прочих публикаций (камера/аудио) обновлять screen-подписку не нужно.
    if (
      !participant.isLocal &&
      (publication.source === Track.Source.ScreenShare ||
        publication.source === Track.Source.ScreenShareAudio)
    ) {
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
    if (!deps.getTargetChannelId() || !deps.isOwnedRoom(room)) return
    syncParticipants()
  })

  room.on(RoomEvent.MediaDevicesError, (error, kind) => {
    if (kind !== 'audioinput') return
    deps.syncMicFromRoom(room, deps.describeMicDeviceError?.(error) ?? error)
  })

  room.on(RoomEvent.Disconnected, () => {
    if (!deps.isOwnedRoom(room)) {
      room.removeAllListeners()
      return
    }

    cleanupRoomRemoteAudio()

    const targetChannelId = deps.getTargetChannelId()
    if (!targetChannelId) {
      deps.abortJoinAttempt()
      return
    }

    deps.onUnexpectedRoomDisconnect(targetChannelId)
  })

  syncParticipants()
}
