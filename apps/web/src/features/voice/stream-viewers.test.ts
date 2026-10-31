import { describe, expect, it } from 'vitest'

import type { UserVoiceState } from '@syrnike13/client/sync/voice-types'

import {
  STREAM_VIEWER_SOUND_LIMIT,
  normalizeWatchedOwnerIds,
  sameWatchedOwnerIds,
  streamViewerIds,
  streamViewerSnapshot,
  streamViewerTransitionSound,
  type StreamViewerSnapshot,
} from './stream-viewers'

function participant(
  id: string,
  options: { screensharing?: boolean; watching?: string[] } = {},
): UserVoiceState {
  return {
    id,
    joined_at: 0,
    self_mute: false,
    self_deaf: false,
    server_muted: false,
    server_deafened: false,
    camera: false,
    screensharing: options.screensharing ?? false,
    watching: options.watching ?? [],
    version: 1,
  }
}

function snapshot(
  streamOwnerId: string | null,
  viewerCount: number,
  channelId: string | null = 'voice-1',
): StreamViewerSnapshot {
  return { channelId, streamOwnerId, viewerCount }
}

describe('streamViewerIds', () => {
  it('lists the participants watching a live screen share', () => {
    const participants = [
      participant('owner', { screensharing: true }),
      participant('viewer-a', { watching: ['owner'] }),
      participant('viewer-b', { watching: ['other', 'owner'] }),
      participant('idle'),
    ]

    expect(streamViewerIds(participants, 'owner')).toEqual([
      'viewer-a',
      'viewer-b',
    ])
  })

  it('has no viewers once the screen share stops', () => {
    const participants = [
      participant('owner'),
      participant('viewer', { watching: ['owner'] }),
    ]

    expect(streamViewerIds(participants, 'owner')).toEqual([])
  })
})

describe('streamViewerSnapshot', () => {
  it('follows the own stream and excludes the current user', () => {
    expect(
      streamViewerSnapshot({
        channelId: 'voice-1',
        currentUserId: 'me',
        participants: [
          participant('me', { screensharing: true }),
          participant('viewer', { watching: ['me'] }),
        ],
        watchedOwnerIds: [],
      }),
    ).toEqual(snapshot('me', 1))
  })

  it('follows the only watched stream without counting the current user', () => {
    expect(
      streamViewerSnapshot({
        channelId: 'voice-1',
        currentUserId: 'me',
        participants: [
          participant('owner', { screensharing: true }),
          participant('me', { watching: ['owner'] }),
          participant('viewer', { watching: ['owner'] }),
        ],
        watchedOwnerIds: ['owner'],
      }),
    ).toEqual(snapshot('owner', 1))
  })

  it('prefers the own stream when several streams are active', () => {
    expect(
      streamViewerSnapshot({
        channelId: 'voice-1',
        currentUserId: 'me',
        participants: [
          participant('me', { screensharing: true }),
          participant('owner', { screensharing: true, watching: ['me'] }),
        ],
        watchedOwnerIds: ['owner'],
      }),
    ).toEqual(snapshot('me', 1))
  })

  it('follows nothing when several watched streams are active', () => {
    expect(
      streamViewerSnapshot({
        channelId: 'voice-1',
        currentUserId: 'me',
        participants: [
          participant('owner-a', { screensharing: true }),
          participant('owner-b', { screensharing: true }),
          participant('me'),
        ],
        watchedOwnerIds: ['owner-a', 'owner-b'],
      }),
    ).toEqual(snapshot(null, 0))
  })

  it('ignores watched streams that are not live', () => {
    expect(
      streamViewerSnapshot({
        channelId: 'voice-1',
        currentUserId: 'me',
        participants: [participant('owner'), participant('me')],
        watchedOwnerIds: ['owner'],
      }),
    ).toEqual(snapshot(null, 0))
  })
})

describe('streamViewerTransitionSound', () => {
  it('plays join and leave when the same stream gains or loses viewers', () => {
    expect(
      streamViewerTransitionSound(snapshot('owner', 1), snapshot('owner', 2)),
    ).toBe('screen_share.viewer_join')
    expect(
      streamViewerTransitionSound(snapshot('owner', 2), snapshot('owner', 1)),
    ).toBe('screen_share.viewer_leave')
  })

  it('stays silent when the followed stream or channel changes', () => {
    expect(
      streamViewerTransitionSound(snapshot(null, 0), snapshot('owner', 3)),
    ).toBeNull()
    expect(
      streamViewerTransitionSound(snapshot('owner-a', 1), snapshot('owner-b', 2)),
    ).toBeNull()
    expect(
      streamViewerTransitionSound(
        snapshot('owner', 1, 'voice-1'),
        snapshot('owner', 2, 'voice-2'),
      ),
    ).toBeNull()
    expect(
      streamViewerTransitionSound(snapshot('owner', 2), snapshot('owner', 2)),
    ).toBeNull()
  })

  it('stays silent for large audiences', () => {
    expect(
      streamViewerTransitionSound(
        snapshot('owner', STREAM_VIEWER_SOUND_LIMIT),
        snapshot('owner', STREAM_VIEWER_SOUND_LIMIT + 1),
      ),
    ).toBe('screen_share.viewer_join')
    expect(
      streamViewerTransitionSound(
        snapshot('owner', STREAM_VIEWER_SOUND_LIMIT + 1),
        snapshot('owner', STREAM_VIEWER_SOUND_LIMIT + 2),
      ),
    ).toBeNull()
  })
})

describe('watched owner ids', () => {
  it('normalizes to a sorted unique list and compares by value', () => {
    const watched = normalizeWatchedOwnerIds(['b', 'a', 'b'])

    expect(watched).toEqual(['a', 'b'])
    expect(sameWatchedOwnerIds(watched, ['a', 'b'])).toBe(true)
    expect(sameWatchedOwnerIds(watched, ['a'])).toBe(false)
  })
})
