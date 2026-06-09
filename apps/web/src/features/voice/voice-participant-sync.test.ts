import { describe, expect, it } from 'vitest'
import { Track } from 'livekit-client'

import { syncStore } from '#/features/sync/sync-store'
import {
  liveKitChannelParticipants,
  syncLiveKitRoomParticipants,
} from '#/features/voice/voice-participant-sync'

const CHANNEL_ID = '01KT7DEM3B0T4B0BXGBXWDJ6AF'
const LOCAL_USER_ID = '01KT7DEM3B0T4B0BXGBXWDJ6AD'
const REMOTE_USER_ID = '01KT7DEM3B0T4B0BXGBXWDJ6AE'

function participant(
  identity: string,
  publication: {
    track?: unknown
    isMuted?: boolean
    isSubscribed?: boolean
    isMicrophoneEnabled?: boolean
    isScreenShareEnabled?: boolean
    screenShareTrack?: unknown
  } = {},
) {
  const value: Record<string, unknown> = {
    identity,
    joinedAt: new Date('2026-06-04T12:00:00.000Z'),
    isCameraEnabled: false,
    isScreenShareEnabled: publication.isScreenShareEnabled ?? false,
    trackPublications: new Map([
      [
        'microphone',
        {
          kind: Track.Kind.Audio,
          source: Track.Source.Microphone,
          track: Object.hasOwn(publication, 'track') ? publication.track : {},
          isMuted: publication.isMuted ?? false,
          isSubscribed: publication.isSubscribed ?? true,
        },
      ],
    ]),
  }

  if (
    publication.screenShareTrack !== undefined ||
    publication.isScreenShareEnabled !== undefined
  ) {
    value.trackPublications = new Map([
      ...(value.trackPublications as Map<string, unknown>),
      [
        'screen',
        {
          kind: Track.Kind.Video,
          source: Track.Source.ScreenShare,
          track: publication.screenShareTrack,
          isMuted: false,
        },
      ],
    ])
  }

  if (publication.isMicrophoneEnabled !== undefined) {
    value.isMicrophoneEnabled = publication.isMicrophoneEnabled
  }

  return value
}

describe('liveKitChannelParticipants', () => {
  it('ignores local and remote participants until LiveKit identity is valid', () => {
    const room = {
      localParticipant: participant(''),
      remoteParticipants: new Map([['', participant('')]]),
    }

    expect(liveKitChannelParticipants(room as never, true)).toEqual([])
  })

  it('ignores explicitly excluded native screen participants after local stop', () => {
    const nativeIdentity = `${LOCAL_USER_ID}:desktop-native:native-screen-1`
    const room = {
      localParticipant: participant(LOCAL_USER_ID, {
        isMicrophoneEnabled: false,
        track: undefined,
      }),
      remoteParticipants: new Map([
        [
          nativeIdentity,
          participant(nativeIdentity, {
            screenShareTrack: {},
          }),
        ],
      ]),
    }

    expect(
      liveKitChannelParticipants(room as never, true, {
        excludedParticipantIdentities: new Set([nativeIdentity]),
      }),
    ).toMatchObject([
      {
        id: LOCAL_USER_ID,
        screensharing: false,
      },
    ])
  })
})

describe('syncLiveKitRoomParticipants', () => {
  it('syncs remote participants without reading existing voice state before initialization', () => {
    syncStore.reset()

    const room = {
      localParticipant: participant(LOCAL_USER_ID, {
        isMicrophoneEnabled: true,
      }),
      remoteParticipants: new Map([[REMOTE_USER_ID, participant(REMOTE_USER_ID)]]),
    }

    expect(() =>
      syncLiveKitRoomParticipants(CHANNEL_ID, room as never, true),
    ).not.toThrow()
    expect(syncStore.getState().voiceParticipants[CHANNEL_ID]).toMatchObject({
      [LOCAL_USER_ID]: {
        id: LOCAL_USER_ID,
        is_publishing: true,
        is_receiving: true,
      },
      [REMOTE_USER_ID]: {
        id: REMOTE_USER_ID,
        is_publishing: true,
        is_receiving: true,
      },
    })
  })

  it('keeps remote microphone enabled when publication is not subscribed yet', () => {
    syncStore.reset()

    const room = {
      localParticipant: participant(LOCAL_USER_ID, {
        isMicrophoneEnabled: true,
      }),
      remoteParticipants: new Map([
        [
          REMOTE_USER_ID,
          participant(REMOTE_USER_ID, {
            track: undefined,
            isSubscribed: false,
          }),
        ],
      ]),
    }

    syncLiveKitRoomParticipants(CHANNEL_ID, room as never, true)

    expect(
      syncStore.getState().voiceParticipants[CHANNEL_ID]?.[REMOTE_USER_ID],
    ).toMatchObject({
      id: REMOTE_USER_ID,
      is_publishing: true,
    })
  })

  it('marks local microphone unavailable when browser kept the enabled flag without a track', () => {
    syncStore.reset()

    const room = {
      localParticipant: participant(LOCAL_USER_ID, {
        isMicrophoneEnabled: true,
        track: undefined,
      }),
      remoteParticipants: new Map(),
    }

    syncLiveKitRoomParticipants(CHANNEL_ID, room as never, true)

    expect(
      syncStore.getState().voiceParticipants[CHANNEL_ID]?.[LOCAL_USER_ID],
    ).toMatchObject({
      id: LOCAL_USER_ID,
      is_publishing: false,
    })
  })

  it('clears local screen share when browser stopped the track outside the app UI', () => {
    syncStore.reset()

    const room = {
      localParticipant: participant(LOCAL_USER_ID, {
        isMicrophoneEnabled: true,
        isScreenShareEnabled: true,
        screenShareTrack: undefined,
      }),
      remoteParticipants: new Map(),
    }

    syncLiveKitRoomParticipants(CHANNEL_ID, room as never, true)

    expect(
      syncStore.getState().voiceParticipants[CHANNEL_ID]?.[LOCAL_USER_ID],
    ).toMatchObject({
      id: LOCAL_USER_ID,
      screensharing: false,
    })
  })

  it('keeps backend server mute flags when liveKit refreshes remote participants', () => {
    syncStore.reset()
    syncStore.setChannelVoiceParticipants(CHANNEL_ID, [
      {
        id: REMOTE_USER_ID,
        joined_at: 1,
        is_publishing: true,
        is_receiving: true,
        server_muted: true,
        server_deafened: true,
        camera: false,
        screensharing: false,
      },
    ])

    const room = {
      localParticipant: participant(LOCAL_USER_ID, {
        isMicrophoneEnabled: true,
      }),
      remoteParticipants: new Map([[REMOTE_USER_ID, participant(REMOTE_USER_ID)]]),
    }

    syncLiveKitRoomParticipants(CHANNEL_ID, room as never, true)

    expect(
      syncStore.getState().voiceParticipants[CHANNEL_ID]?.[REMOTE_USER_ID],
    ).toMatchObject({
      server_muted: true,
      server_deafened: true,
    })
  })

  it('merges desktop native microphone participant into the base user', () => {
    syncStore.reset()

    const room = {
      localParticipant: participant(LOCAL_USER_ID, {
        isMicrophoneEnabled: false,
        track: undefined,
      }),
      remoteParticipants: new Map([
        [
          `${LOCAL_USER_ID}:desktop-native`,
          participant(`${LOCAL_USER_ID}:desktop-native`),
        ],
      ]),
    }

    syncLiveKitRoomParticipants(CHANNEL_ID, room as never, true)

    expect(Object.keys(syncStore.getState().voiceParticipants[CHANNEL_ID] ?? {}))
      .toEqual([LOCAL_USER_ID])
    expect(
      syncStore.getState().voiceParticipants[CHANNEL_ID]?.[LOCAL_USER_ID],
    ).toMatchObject({
      id: LOCAL_USER_ID,
      is_publishing: true,
    })
  })

  it('merges session-scoped desktop native participant into the base user', () => {
    syncStore.reset()

    const room = {
      localParticipant: participant(LOCAL_USER_ID, {
        isMicrophoneEnabled: false,
        track: undefined,
      }),
      remoteParticipants: new Map([
        [
          `${LOCAL_USER_ID}:desktop-native:native-screen-1`,
          participant(`${LOCAL_USER_ID}:desktop-native:native-screen-1`, {
            screenShareTrack: {},
          }),
        ],
      ]),
    }

    syncLiveKitRoomParticipants(CHANNEL_ID, room as never, true)

    expect(Object.keys(syncStore.getState().voiceParticipants[CHANNEL_ID] ?? {}))
      .toEqual([LOCAL_USER_ID])
    expect(
      syncStore.getState().voiceParticipants[CHANNEL_ID]?.[LOCAL_USER_ID],
    ).toMatchObject({
      id: LOCAL_USER_ID,
      screensharing: true,
    })
  })

  it('keeps native screen share enabled before the remote track is attached', () => {
    syncStore.reset()

    const room = {
      localParticipant: participant(LOCAL_USER_ID, {
        isMicrophoneEnabled: false,
        track: undefined,
      }),
      remoteParticipants: new Map([
        [
          `${LOCAL_USER_ID}:desktop-native:native-screen-1`,
          participant(`${LOCAL_USER_ID}:desktop-native:native-screen-1`, {
            isScreenShareEnabled: true,
            screenShareTrack: null,
          }),
        ],
      ]),
    }

    syncLiveKitRoomParticipants(CHANNEL_ID, room as never, true)

    expect(
      syncStore.getState().voiceParticipants[CHANNEL_ID]?.[LOCAL_USER_ID],
    ).toMatchObject({
      id: LOCAL_USER_ID,
      screensharing: true,
    })
  })
})
