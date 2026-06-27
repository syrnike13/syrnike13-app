import {
  RoomEvent,
  Track,
  type RemoteParticipant,
  type RemoteTrackPublication,
  type Room,
} from 'livekit-client'

import { baseVoiceIdentity } from '#/features/voice/native-voice-identity'

export type NativeScreenPublicationMatch = {
  participantIdentity: string
  publicationSid: string
  publication: RemoteTrackPublication
}

export type NativeScreenPublicationOptions = {
  userId?: string
  nativeParticipantIdentity?: string
}

function publicationSid(publication: RemoteTrackPublication) {
  return publication.trackSid || publication.sid
}

function isNativeScreenParticipant(
  participant: Pick<RemoteParticipant, 'identity'>,
  options: NativeScreenPublicationOptions,
) {
  if (
    options.nativeParticipantIdentity &&
    participant.identity !== options.nativeParticipantIdentity
  ) {
    return false
  }
  if (options.userId && baseVoiceIdentity(participant.identity) !== options.userId) {
    return false
  }
  return participant.identity.includes(':desktop-native')
}

export function findNativeScreenPublication(
  room: Pick<Room, 'remoteParticipants'>,
  options: NativeScreenPublicationOptions,
): NativeScreenPublicationMatch | null {
  for (const participant of room.remoteParticipants.values()) {
    if (!isNativeScreenParticipant(participant, options)) continue

    for (const publication of participant.trackPublications.values()) {
      if (publication.source !== Track.Source.ScreenShare) continue
      const sid = publicationSid(publication)
      if (!sid) continue
      return {
        participantIdentity: participant.identity,
        publicationSid: sid,
        publication,
      }
    }
  }

  return null
}

export function waitForNativeScreenPublication(
  room: Room,
  options: NativeScreenPublicationOptions,
  timeoutMs = 5_000,
): Promise<NativeScreenPublicationMatch> {
  return new Promise((resolve, reject) => {
    let settled = false
    const cleanup = () => {
      room.off(RoomEvent.TrackPublished, check)
      room.off(RoomEvent.TrackSubscribed, check)
      room.off(RoomEvent.ParticipantConnected, check)
      room.off(RoomEvent.Disconnected, fail)
      clearTimeout(timer)
    }
    const finish = (match: NativeScreenPublicationMatch) => {
      if (settled) return
      settled = true
      cleanup()
      resolve(match)
    }
    const fail = () => {
      if (settled) return
      settled = true
      cleanup()
      reject(new Error('Native screen publication was not observed in the current room'))
    }
    const check = () => {
      const match = findNativeScreenPublication(room, options)
      if (match) finish(match)
    }
    const timer = setTimeout(fail, timeoutMs)

    room.on(RoomEvent.TrackPublished, check)
    room.on(RoomEvent.TrackSubscribed, check)
    room.on(RoomEvent.ParticipantConnected, check)
    room.on(RoomEvent.Disconnected, fail)

    check()
  })
}
