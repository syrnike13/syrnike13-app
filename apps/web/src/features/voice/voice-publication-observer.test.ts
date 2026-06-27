import { RoomEvent, Track, type Room } from 'livekit-client'
import { describe, expect, it } from 'vitest'

import {
  findNativeScreenPublication,
  waitForNativeScreenPublication,
} from './voice-publication-observer'

function publication(sid: string, source = Track.Source.ScreenShare) {
  return { sid, trackSid: sid, source, isMuted: false }
}

function participant(identity: string, publications: unknown[]) {
  return {
    identity,
    trackPublications: new Map(
      publications.map((entry, index) => [`pub-${index}`, entry]),
    ),
  }
}

function observableRoom() {
  const listeners = new Map<string, Set<() => void>>()
  return {
    remoteParticipants: new Map(),
    on(event: string, listener: () => void) {
      const eventListeners = listeners.get(event) ?? new Set()
      eventListeners.add(listener)
      listeners.set(event, eventListeners)
    },
    off(event: string, listener: () => void) {
      listeners.get(event)?.delete(listener)
    },
    emit(event: string) {
      for (const listener of listeners.get(event) ?? []) listener()
    },
    listenerCount(event: string) {
      return listeners.get(event)?.size ?? 0
    },
  }
}

describe('voice publication observer', () => {
  it('finds native screen publication for the current user', () => {
    const room = {
      remoteParticipants: new Map([
        [
          'native-screen',
          participant('user-1:desktop-native:screen', [
            publication('screen-pub-1'),
          ]),
        ],
      ]),
    }

    expect(
      findNativeScreenPublication(room as never, {
        userId: 'user-1',
        nativeParticipantIdentity: 'user-1:desktop-native:screen',
      }),
    ).toMatchObject({
      participantIdentity: 'user-1:desktop-native:screen',
      publicationSid: 'screen-pub-1',
    })
  })

  it('ignores native screen publications for another user', () => {
    const room = {
      remoteParticipants: new Map([
        [
          'native-screen',
          participant('user-2:desktop-native:screen', [
            publication('screen-pub-2'),
          ]),
        ],
      ]),
    }

    expect(
      findNativeScreenPublication(room as never, {
        userId: 'user-1',
        nativeParticipantIdentity: 'user-1:desktop-native:screen',
      }),
    ).toBeNull()
  })

  it('ignores non-screen publications from the native screen participant', () => {
    const room = {
      remoteParticipants: new Map([
        [
          'native-screen',
          participant('user-1:desktop-native:screen', [
            publication('audio-pub-1', Track.Source.ScreenShareAudio),
          ]),
        ],
      ]),
    }

    expect(
      findNativeScreenPublication(room as never, {
        userId: 'user-1',
        nativeParticipantIdentity: 'user-1:desktop-native:screen',
      }),
    ).toBeNull()
  })

  it('stops waiting when the room disconnects', async () => {
    const room = observableRoom()
    const promise = waitForNativeScreenPublication(room as unknown as Room, {
      userId: 'user-1',
      nativeParticipantIdentity: 'user-1:desktop-native:screen',
    })

    room.emit(RoomEvent.Disconnected)

    await expect(promise).rejects.toThrow(
      'Native screen publication was not observed in the current room',
    )
    expect(room.listenerCount(RoomEvent.Disconnected)).toBe(0)
  })
})
