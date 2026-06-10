import { describe, expect, it } from 'vitest'

import {
  EMPTY_DESKTOP_OVERLAY_SNAPSHOT,
  normalizeDesktopOverlayPreferences,
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

  it('keeps detected games with per-game overlay toggles', () => {
    expect(
      normalizeDesktopOverlayPreferences({
        enabled: true,
        games: [
          {
            id: 'c:/games/raid.exe',
            processName: 'raid.exe',
            processPath: 'C:/Games/Raid.exe',
            title: 'Raid',
            enabled: false,
            lastSeenAt: 123,
          },
          {
            id: '',
            processName: '',
            processPath: null,
            title: 42,
            enabled: true,
            lastSeenAt: 'now',
          },
        ],
      }),
    ).toEqual({
      enabled: true,
      games: [
        {
          id: 'c:/games/raid.exe',
          processName: 'raid.exe',
          processPath: 'C:/Games/Raid.exe',
          title: 'Raid',
          enabled: false,
          lastSeenAt: 123,
        },
      ],
    })
  })
})
