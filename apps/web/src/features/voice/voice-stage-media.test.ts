import { describe, expect, it } from 'vitest'

import {
  buildStageMediaItems,
  type StageMediaTrackEntry,
} from '#/features/voice/voice-stage-media'

const LOCAL_USER_ID = 'local-user'
const REMOTE_USER_ID = 'remote-user'
const QUIET_USER_ID = 'quiet-user'

const participants = [
  { id: LOCAL_USER_ID },
  { id: REMOTE_USER_ID },
  { id: QUIET_USER_ID },
]

const defaultFilters = {
  showOwnStream: true,
  showRemoteStreams: true,
  showParticipantsWithoutMedia: true,
}

function track(
  userId: string,
  source: StageMediaTrackEntry['source'],
  fields: Partial<StageMediaTrackEntry> = {},
): StageMediaTrackEntry {
  return {
    userId,
    source,
    track: { userId, source },
    publication: { source },
    subscribed: true,
    live: true,
    ...fields,
  }
}

describe('buildStageMediaItems', () => {
  it('keeps screen share and camera as separate sibling items', () => {
    const items = buildStageMediaItems({
      participants,
      currentUserId: LOCAL_USER_ID,
      tracks: [
        track(REMOTE_USER_ID, 'screen'),
        track(REMOTE_USER_ID, 'camera'),
      ],
      filters: defaultFilters,
    })

    expect(items).toEqual([
      expect.objectContaining({
        id: `${LOCAL_USER_ID}:avatar`,
        userId: LOCAL_USER_ID,
        kind: 'avatar',
        isLocal: true,
        live: true,
      }),
      expect.objectContaining({
        id: `${REMOTE_USER_ID}:screen`,
        userId: REMOTE_USER_ID,
        kind: 'screen',
        source: 'screen',
        isLocal: false,
        subscribed: true,
        live: true,
      }),
      expect.objectContaining({
        id: `${REMOTE_USER_ID}:camera`,
        userId: REMOTE_USER_ID,
        kind: 'camera',
        source: 'camera',
        isLocal: false,
        subscribed: true,
        live: true,
      }),
      expect.objectContaining({
        id: `${QUIET_USER_ID}:avatar`,
        userId: QUIET_USER_ID,
        kind: 'avatar',
        isLocal: false,
        live: true,
      }),
    ])
  })

  it('keeps an avatar tile for a screen-only participant', () => {
    const items = buildStageMediaItems({
      participants: [{ id: REMOTE_USER_ID }],
      currentUserId: LOCAL_USER_ID,
      tracks: [track(REMOTE_USER_ID, 'screen')],
      filters: defaultFilters,
    })

    expect(items.map((item) => item.id)).toEqual([
      `${REMOTE_USER_ID}:screen`,
      `${REMOTE_USER_ID}:avatar`,
    ])
  })

  it('replaces avatar with camera while keeping screen separate', () => {
    const items = buildStageMediaItems({
      participants: [{ id: REMOTE_USER_ID }],
      currentUserId: LOCAL_USER_ID,
      tracks: [
        track(REMOTE_USER_ID, 'screen'),
        track(REMOTE_USER_ID, 'camera'),
      ],
      filters: defaultFilters,
    })

    expect(items.map((item) => item.id)).toEqual([
      `${REMOTE_USER_ID}:screen`,
      `${REMOTE_USER_ID}:camera`,
    ])
  })

  it('keeps a live subscribed remote screen item when the track is not attached yet', () => {
    const items = buildStageMediaItems({
      participants,
      currentUserId: LOCAL_USER_ID,
      tracks: [
        track(REMOTE_USER_ID, 'screen', {
          track: null,
          publication: { source: 'screen', sid: 'remote-screen-publication' },
          subscribed: true,
          live: true,
        }),
      ],
      filters: defaultFilters,
    })

    expect(items).toContainEqual(
      expect.objectContaining({
        id: `${REMOTE_USER_ID}:screen`,
        userId: REMOTE_USER_ID,
        kind: 'screen',
        source: 'screen',
        track: null,
        publication: { source: 'screen', sid: 'remote-screen-publication' },
        subscribed: true,
        live: true,
      }),
    )
  })

  it('filters own streams, remote streams, and participants without media', () => {
    const tracks = [
      track(LOCAL_USER_ID, 'camera'),
      track(REMOTE_USER_ID, 'screen'),
    ]

    expect(
      buildStageMediaItems({
        participants,
        currentUserId: LOCAL_USER_ID,
        tracks,
        filters: {
          ...defaultFilters,
          showOwnStream: false,
        },
      }).map((item) => item.id),
    ).toEqual([
      `${REMOTE_USER_ID}:screen`,
      `${REMOTE_USER_ID}:avatar`,
      `${QUIET_USER_ID}:avatar`,
    ])

    expect(
      buildStageMediaItems({
        participants,
        currentUserId: LOCAL_USER_ID,
        tracks,
        filters: {
          ...defaultFilters,
          showRemoteStreams: false,
        },
      }).map((item) => item.id),
    ).toEqual([`${LOCAL_USER_ID}:camera`])

    expect(
      buildStageMediaItems({
        participants,
        currentUserId: LOCAL_USER_ID,
        tracks,
        filters: {
          ...defaultFilters,
          showParticipantsWithoutMedia: false,
        },
      }).map((item) => item.id),
    ).toEqual([`${LOCAL_USER_ID}:camera`, `${REMOTE_USER_ID}:screen`])
  })
})
