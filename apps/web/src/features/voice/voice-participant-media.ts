import type { LocalParticipant, Participant, RemoteParticipant } from 'livekit-client'
import { Track } from 'livekit-client'

/** Фактическая публикация микрофона: publication metadata важнее локального флага. */
export function participantMicPublishing(participant: Participant) {
  const localParticipant = 'isMicrophoneEnabled' in participant

  for (const publication of participant.trackPublications.values()) {
    if (publication.kind !== Track.Kind.Audio) continue
    if (publication.source !== Track.Source.Microphone) continue
    if (publication.isMuted) continue
    if (localParticipant && !publication.track) continue
    return true
  }

  return false
}

export function participantHasCamera(participant: Participant) {
  return hasPublishedVideoSource(participant, Track.Source.Camera)
}

export function participantHasScreenShare(participant: Participant) {
  return hasPublishedVideoSource(
    participant,
    Track.Source.ScreenShare,
    false,
  )
}

function hasPublishedVideoSource(
  participant: Participant,
  source: Track.Source.Camera | Track.Source.ScreenShare,
  requireTrack = false,
) {
  for (const publication of participant.trackPublications.values()) {
    if (publication.source !== source) continue
    if (publication.isMuted) continue
    if (requireTrack && !publication.track) continue
    return true
  }
  return false
}

export function localParticipantVoiceFlags(participant: LocalParticipant) {
  return {
    camera: hasPublishedVideoSource(
      participant,
      Track.Source.Camera,
      true,
    ),
    screensharing: hasPublishedVideoSource(
      participant,
      Track.Source.ScreenShare,
      true,
    ),
  }
}

export function remoteParticipantVoiceFlags(participant: RemoteParticipant) {
  return {
    camera: participantHasCamera(participant),
    screensharing: hasPublishedVideoSource(
      participant,
      Track.Source.ScreenShare,
      false,
    ),
  }
}
