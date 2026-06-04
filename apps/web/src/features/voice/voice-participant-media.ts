import type { LocalParticipant, Participant, RemoteParticipant } from 'livekit-client'
import { Track } from 'livekit-client'

/** Фактическая публикация микрофона: трек важнее флага isMicrophoneEnabled. */
export function participantMicPublishing(participant: Participant) {
  for (const publication of participant.trackPublications.values()) {
    if (publication.kind !== Track.Kind.Audio) continue
    if (publication.source !== Track.Source.Microphone) continue
    if (!publication.track || publication.isMuted) continue
    if ('isSubscribed' in publication && !publication.isSubscribed) continue
    return true
  }

  if ('isMicrophoneEnabled' in participant) {
    return participant.isMicrophoneEnabled
  }

  return false
}

export function participantHasCamera(participant: Participant) {
  if ('isCameraEnabled' in participant && participant.isCameraEnabled) {
    return true
  }
  return hasPublishedVideoSource(participant, Track.Source.Camera)
}

export function participantHasScreenShare(participant: Participant) {
  if ('isScreenShareEnabled' in participant && participant.isScreenShareEnabled) {
    return true
  }
  return hasPublishedVideoSource(participant, Track.Source.ScreenShare)
}

function hasPublishedVideoSource(
  participant: Participant,
  source: Track.Source.Camera | Track.Source.ScreenShare,
) {
  for (const publication of participant.trackPublications.values()) {
    if (publication.source !== source) continue
    if (publication.track && !publication.isMuted) return true
  }
  return false
}

export function localParticipantVoiceFlags(participant: LocalParticipant) {
  return {
    camera: participantHasCamera(participant),
    screensharing: participantHasScreenShare(participant),
  }
}

export function remoteParticipantVoiceFlags(participant: RemoteParticipant) {
  return {
    camera: participantHasCamera(participant),
    screensharing: participantHasScreenShare(participant),
  }
}
