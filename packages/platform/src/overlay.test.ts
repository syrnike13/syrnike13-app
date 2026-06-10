import { describe, expect, it } from 'vitest'

import {
  EMPTY_DESKTOP_OVERLAY_SNAPSHOT,
  normalizeDesktopOverlaySnapshot,
} from './overlay'

describe('desktop overlay snapshot', () => {
  it('keeps a valid voice participant snapshot', () => {
    expect(
      normalizeDesktopOverlaySnapshot({
        active: true,
        channelId: 'voice-1',
        channelLabel: 'Raid voice',
        participants: [
          {
            userId: 'user-1',
            displayName: 'Mira',
            avatarUrl: 'https://cdn.example/avatar.png',
            speaking: true,
            muted: false,
            deafened: true,
          },
        ],
      }),
    ).toEqual({
      active: true,
      channelId: 'voice-1',
      channelLabel: 'Raid voice',
      participants: [
        {
          userId: 'user-1',
          displayName: 'Mira',
          avatarUrl: 'https://cdn.example/avatar.png',
          speaking: true,
          muted: false,
          deafened: true,
        },
      ],
    })
  })

  it('drops invalid participants and falls back to an inactive snapshot', () => {
    expect(
      normalizeDesktopOverlaySnapshot({
        active: true,
        channelId: '',
        channelLabel: 42,
        participants: [
          {
            userId: 'user-1',
            displayName: '',
            avatarUrl: null,
            speaking: 'yes',
            muted: false,
            deafened: false,
          },
        ],
      }),
    ).toEqual(EMPTY_DESKTOP_OVERLAY_SNAPSHOT)
  })

})
