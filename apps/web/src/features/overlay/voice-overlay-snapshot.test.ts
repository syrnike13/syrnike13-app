import { describe, expect, it } from 'vitest'

import { buildVoiceOverlaySnapshot } from './voice-overlay-snapshot'

describe('buildVoiceOverlaySnapshot', () => {
  it('builds a compact participant list for the active voice channel', () => {
    const snapshot = buildVoiceOverlaySnapshot({
      channelId: 'voice-1',
      channelLabel: 'General voice',
      participants: [
        {
          id: 'user-muted',
          joined_at: 20,
          self_mute: true,
          self_deaf: false,
          server_muted: false,
          server_deafened: false,
          camera: false,
          screensharing: false,
          version: 1,
        },
        {
          id: 'user-speaking',
          joined_at: 10,
          self_mute: false,
          self_deaf: false,
          server_muted: false,
          server_deafened: true,
          camera: false,
          screensharing: false,
          version: 1,
        },
      ],
      speakingUserIds: new Set(['user-speaking']),
      users: {
        'user-muted': {
          _id: 'user-muted',
          username: 'muted',
          display_name: 'Muted User',
          avatar: null,
        },
        'user-speaking': {
          _id: 'user-speaking',
          username: 'speaker',
          display_name: 'Speaker',
          avatar: {
            _id: 'avatar-1',
            tag: 'avatars',
            filename: 'speaker.png',
            content_type: 'image/png',
            metadata: { type: 'Image', width: 128, height: 128 },
            size: 1024,
          },
        },
      },
    })

    expect(snapshot).toEqual({
      active: true,
      channelId: 'voice-1',
      channelLabel: 'General voice',
      participants: [
        {
          userId: 'user-speaking',
          displayName: 'Speaker',
          avatarUrl: 'https://syrnike13.ru/autumn/avatars/avatar-1',
          speaking: true,
          muted: false,
          deafened: true,
        },
        {
          userId: 'user-muted',
          displayName: 'Muted User',
          avatarUrl: null,
          speaking: false,
          muted: true,
          deafened: false,
        },
      ],
    })
  })

  it('returns an inactive snapshot when no channel is active', () => {
    expect(
      buildVoiceOverlaySnapshot({
        channelId: null,
        channelLabel: null,
        participants: [],
        speakingUserIds: new Set(),
        users: {},
      }),
    ).toEqual({
      active: false,
      channelId: null,
      channelLabel: null,
      participants: [],
    })
  })
})
