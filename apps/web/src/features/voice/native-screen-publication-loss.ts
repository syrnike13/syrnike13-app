import {
  Track,
  type RemoteTrackPublication,
  type Room,
} from 'livekit-client'

type RemoteTrackPublicationWithLegacySid = RemoteTrackPublication & {
  sid?: string
}

export type NativeScreenPublicationLossReason =
  | 'participant-disconnected'
  | 'track-unpublished'
  | 'publication-missing'

export type NativeScreenPublicationLoss = {
  reason: NativeScreenPublicationLossReason
  participantIdentity: string
  publicationSid?: string
  remoteParticipants?: number
}

export type NativeScreenPublicationLossHandler = (
  loss: NativeScreenPublicationLoss,
) => void

type PublishedNativeScreenPublicationState = {
  status: 'published'
  participantIdentity: string
  publicationSid: string
}

export type NativeScreenPublicationState =
  | PublishedNativeScreenPublicationState
  | { status: string; participantIdentity?: string; publicationSid?: string }

type NativeScreenPublicationLossContext = {
  screen: NativeScreenPublicationState
  stoppedNativeScreenIdentity: string | null
  remoteParticipants: number
}

export function remoteNativeScreenPublicationSid(
  publication: RemoteTrackPublication,
) {
  return (
    publication.trackSid ||
    (publication as RemoteTrackPublicationWithLegacySid).sid
  )
}

function isPublishedNativeScreenPublication(
  screen: NativeScreenPublicationState,
): screen is PublishedNativeScreenPublicationState {
  return (
    screen.status === 'published' &&
    typeof screen.participantIdentity === 'string' &&
    typeof screen.publicationSid === 'string'
  )
}

export function isCurrentNativeScreenParticipant(
  screen: NativeScreenPublicationState,
  participantIdentity: string,
) {
  return (
    isPublishedNativeScreenPublication(screen) &&
    screen.participantIdentity === participantIdentity
  )
}

export function isCurrentNativeScreenPublication(
  screen: NativeScreenPublicationState,
  participantIdentity: string,
  publication: RemoteTrackPublication,
) {
  if (!isCurrentNativeScreenParticipant(screen, participantIdentity)) {
    return false
  }
  return remoteNativeScreenPublicationSid(publication) === screen.publicationSid
}

export function hasCurrentNativeScreenPublication(
  room: Room,
  screen: NativeScreenPublicationState,
) {
  if (!isPublishedNativeScreenPublication(screen)) return false
  const { participantIdentity, publicationSid } = screen
  const participant = room.remoteParticipants.get(participantIdentity)
  if (!participant) return false

  for (const publication of participant.trackPublications.values()) {
    if (publication.source !== Track.Source.ScreenShare) continue
    if (remoteNativeScreenPublicationSid(publication) === publicationSid) {
      return true
    }
  }

  return false
}

export function detectNativeScreenParticipantDisconnectLoss(
  context: NativeScreenPublicationLossContext & {
    participantIdentity: string
  },
): NativeScreenPublicationLoss | null {
  const { screen, participantIdentity } = context
  if (context.stoppedNativeScreenIdentity === participantIdentity) return null
  if (!isPublishedNativeScreenPublication(screen)) return null
  if (!isCurrentNativeScreenParticipant(screen, participantIdentity)) {
    return null
  }

  return {
    reason: 'participant-disconnected',
    participantIdentity,
    publicationSid: screen.publicationSid,
    remoteParticipants: context.remoteParticipants,
  }
}

export function detectNativeScreenTrackUnpublishedLoss(
  context: NativeScreenPublicationLossContext & {
    participantIdentity: string
    publication: RemoteTrackPublication
  },
): NativeScreenPublicationLoss | null {
  const { screen, participantIdentity, publication } = context
  if (context.stoppedNativeScreenIdentity === participantIdentity) return null
  if (publication.source !== Track.Source.ScreenShare) return null
  if (
    !isCurrentNativeScreenPublication(screen, participantIdentity, publication)
  ) {
    return null
  }

  return {
    reason: 'track-unpublished',
    participantIdentity,
    publicationSid: remoteNativeScreenPublicationSid(publication),
    remoteParticipants: context.remoteParticipants,
  }
}

export function detectMissingNativeScreenPublicationLoss(
  context: NativeScreenPublicationLossContext & {
    room: Room
    nativeScreenPublicationPresent?: boolean | null
  },
): NativeScreenPublicationLoss | null {
  const { screen } = context
  if (!isPublishedNativeScreenPublication(screen)) return null
  if (context.stoppedNativeScreenIdentity === screen.participantIdentity) {
    return null
  }
  const publicationPresent =
    context.nativeScreenPublicationPresent ??
    hasCurrentNativeScreenPublication(context.room, screen)
  if (publicationPresent) return null

  return {
    reason: 'publication-missing',
    participantIdentity: screen.participantIdentity,
    publicationSid: screen.publicationSid,
    remoteParticipants: context.remoteParticipants,
  }
}
