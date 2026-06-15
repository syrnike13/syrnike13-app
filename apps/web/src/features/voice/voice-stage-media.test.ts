import { describe, expect, it, vi } from 'vitest'

import { withConnectingLocalAvatarItem } from '#/features/voice/voice-connecting-preview'
import {
  buildStageMediaItems,
  filterStageVideoMediaItems,
  sortStageMediaItemsForGrid,
  stageMediaKindLabel,
  type StageMediaItem,
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

  it('keeps an unsubscribed remote screen as a watch tile', () => {
    const items = buildStageMediaItems({
      participants: [{ id: REMOTE_USER_ID }],
      currentUserId: LOCAL_USER_ID,
      tracks: [
        track(REMOTE_USER_ID, 'screen', {
          track: null,
          publication: { source: 'screen', sid: 'remote-screen-publication' },
          subscribed: false,
          live: true,
        }),
      ],
      filters: defaultFilters,
    })

    expect(items).toEqual([
      expect.objectContaining({
        id: `${REMOTE_USER_ID}:screen`,
        userId: REMOTE_USER_ID,
        kind: 'screen',
        source: 'screen',
        track: null,
        publication: { source: 'screen', sid: 'remote-screen-publication' },
        subscribed: false,
        live: true,
      }),
      expect.objectContaining({
        id: `${REMOTE_USER_ID}:avatar`,
        userId: REMOTE_USER_ID,
        kind: 'avatar',
      }),
    ])
  })

  it('keeps an unsubscribed remote screen when participants without media are hidden', () => {
    const items = buildStageMediaItems({
      participants: [{ id: REMOTE_USER_ID }],
      currentUserId: LOCAL_USER_ID,
      tracks: [
        track(REMOTE_USER_ID, 'screen', {
          track: null,
          publication: { source: 'screen', sid: 'remote-screen-publication' },
          subscribed: false,
          live: true,
        }),
      ],
      filters: {
        ...defaultFilters,
        showParticipantsWithoutMedia: false,
      },
    })

    expect(items).toEqual([
      expect.objectContaining({
        id: `${REMOTE_USER_ID}:screen`,
        userId: REMOTE_USER_ID,
        kind: 'screen',
        track: null,
        subscribed: false,
        live: true,
      }),
    ])
  })

  it('keeps a subscribed remote screen loading tile when participants without media are hidden', () => {
    const items = buildStageMediaItems({
      participants: [{ id: REMOTE_USER_ID }],
      currentUserId: LOCAL_USER_ID,
      tracks: [
        track(REMOTE_USER_ID, 'screen', {
          track: null,
          publication: { source: 'screen', sid: 'remote-screen-publication' },
          subscribed: true,
          live: true,
        }),
      ],
      filters: {
        ...defaultFilters,
        showParticipantsWithoutMedia: false,
      },
    })

    expect(items).toEqual([
      expect.objectContaining({
        id: `${REMOTE_USER_ID}:screen`,
        userId: REMOTE_USER_ID,
        kind: 'screen',
        track: null,
        subscribed: true,
        live: true,
      }),
    ])
  })

  it('keeps the most live duplicate track for the same user and source', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    try {
      const stalePublication = { source: 'screen', sid: 'stale-screen' }
      const livePublication = { source: 'screen', sid: 'live-screen' }
      const items = buildStageMediaItems({
        participants: [{ id: REMOTE_USER_ID }],
        currentUserId: LOCAL_USER_ID,
        tracks: [
          track(REMOTE_USER_ID, 'screen', {
            track: null,
            publication: stalePublication,
            subscribed: false,
            live: false,
          }),
          track(REMOTE_USER_ID, 'screen', {
            track: { id: 'live-track' },
            publication: livePublication,
            subscribed: true,
            live: true,
          }),
        ],
        filters: defaultFilters,
      })

      expect(items).toContainEqual(
        expect.objectContaining({
          id: `${REMOTE_USER_ID}:screen`,
          publication: livePublication,
          track: { id: 'live-track' },
        }),
      )
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining(
          `Duplicate stage media track for user ${REMOTE_USER_ID} and source screen`,
        ),
      )
    } finally {
      warn.mockRestore()
    }
  })

  it('keeps the first duplicate track when candidates have the same priority', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    try {
      const firstPublication = { source: 'camera', sid: 'first-camera' }
      const secondPublication = { source: 'camera', sid: 'second-camera' }
      const items = buildStageMediaItems({
        participants: [{ id: REMOTE_USER_ID }],
        currentUserId: LOCAL_USER_ID,
        tracks: [
          track(REMOTE_USER_ID, 'camera', {
            publication: firstPublication,
          }),
          track(REMOTE_USER_ID, 'camera', {
            publication: secondPublication,
          }),
        ],
        filters: defaultFilters,
      })

      expect(items).toContainEqual(
        expect.objectContaining({
          id: `${REMOTE_USER_ID}:camera`,
          publication: firstPublication,
        }),
      )
    } finally {
      warn.mockRestore()
    }
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
      `${LOCAL_USER_ID}:avatar`,
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
    ).toEqual([
      `${LOCAL_USER_ID}:camera`,
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
          showParticipantsWithoutMedia: false,
        },
      }).map((item) => item.id),
    ).toEqual([`${LOCAL_USER_ID}:camera`, `${REMOTE_USER_ID}:screen`])
  })

  it('keeps the local avatar tile when own streams are hidden', () => {
    const items = buildStageMediaItems({
      participants: [{ id: LOCAL_USER_ID }],
      currentUserId: LOCAL_USER_ID,
      tracks: [
        track(LOCAL_USER_ID, 'screen'),
        track(LOCAL_USER_ID, 'camera'),
      ],
      filters: {
        ...defaultFilters,
        showOwnStream: false,
      },
    })

    expect(items.map((item) => item.id)).toEqual([`${LOCAL_USER_ID}:avatar`])
  })

  it('keeps remote avatar tiles when remote streams are hidden', () => {
    const items = buildStageMediaItems({
      participants: [{ id: REMOTE_USER_ID }],
      currentUserId: LOCAL_USER_ID,
      tracks: [
        track(REMOTE_USER_ID, 'screen'),
        track(REMOTE_USER_ID, 'camera'),
      ],
      filters: {
        ...defaultFilters,
        showRemoteStreams: false,
      },
    })

    expect(items.map((item) => item.id)).toEqual([`${REMOTE_USER_ID}:avatar`])
  })
})
describe('withConnectingLocalAvatarItem', () => {
  it('adds a pending local avatar tile while connecting', () => {
    const items = withConnectingLocalAvatarItem(
      buildStageMediaItems({
        participants: [{ id: REMOTE_USER_ID }],
        currentUserId: LOCAL_USER_ID,
        tracks: [],
        filters: defaultFilters,
      }),
      {
        connecting: true,
        localUserId: LOCAL_USER_ID,
        filters: defaultFilters,
      },
    )

    expect(items).toContainEqual(
      expect.objectContaining({
        id: `${LOCAL_USER_ID}:avatar`,
        userId: LOCAL_USER_ID,
        kind: 'avatar',
        isLocal: true,
        live: false,
        pending: true,
      }),
    )
  })

  it('does not duplicate the local tile when it already exists', () => {
    const base = buildStageMediaItems({
      participants: [{ id: LOCAL_USER_ID }],
      currentUserId: LOCAL_USER_ID,
      tracks: [],
      filters: defaultFilters,
    })

    const items = withConnectingLocalAvatarItem(base, {
      connecting: true,
      localUserId: LOCAL_USER_ID,
      filters: defaultFilters,
    })

    expect(items.filter((item) => item.userId === LOCAL_USER_ID)).toHaveLength(1)
  })

  it('keeps the pending local avatar when own streams are hidden', () => {
    const items = withConnectingLocalAvatarItem<StageMediaItem>([], {
      connecting: true,
      localUserId: LOCAL_USER_ID,
      filters: {
        ...defaultFilters,
        showOwnStream: false,
      },
    })

    expect(items.map((item) => item.id)).toEqual([`${LOCAL_USER_ID}:avatar`])
  })
})

describe('stageMediaKindLabel', () => {
  it('maps stream kinds to Russian labels', () => {
    expect(stageMediaKindLabel('screen')).toBe('Экран')
    expect(stageMediaKindLabel('camera')).toBe('Камера')
    expect(stageMediaKindLabel('avatar')).toBeNull()
  })
})

describe('filterStageVideoMediaItems', () => {
  it('keeps only camera and screen items', () => {
    const items = [
      { id: 'a:avatar', kind: 'avatar' as const },
      { id: 'b:screen', kind: 'screen' as const },
      { id: 'c:camera', kind: 'camera' as const },
    ]

    expect(filterStageVideoMediaItems(items).map((item) => item.id)).toEqual([
      'b:screen',
      'c:camera',
    ])
  })
})

describe('sortStageMediaItemsForGrid', () => {
  it('places screen shares and cameras before avatar tiles', () => {
    const items = [
      { id: 'a:avatar', kind: 'avatar' as const },
      { id: 'b:screen', kind: 'screen' as const },
      { id: 'c:camera', kind: 'camera' as const },
      { id: 'd:avatar', kind: 'avatar' as const },
    ]

    expect(sortStageMediaItemsForGrid(items).map((item) => item.id)).toEqual([
      'b:screen',
      'c:camera',
      'a:avatar',
      'd:avatar',
    ])
  })
})
