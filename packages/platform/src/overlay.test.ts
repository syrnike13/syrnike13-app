import { describe, expect, it } from 'vitest'

import {
  DESKTOP_OVERLAY_MAX_AVATAR_URL_LENGTH,
  DESKTOP_OVERLAY_MAX_CHANNEL_ID_LENGTH,
  DESKTOP_OVERLAY_MAX_CHANNEL_LABEL_LENGTH,
  DESKTOP_OVERLAY_MAX_DISPLAY_NAME_LENGTH,
  DESKTOP_OVERLAY_MAX_PARTICIPANTS,
  DESKTOP_OVERLAY_MAX_USER_ID_LENGTH,
  EMPTY_DESKTOP_OVERLAY_SNAPSHOT,
  desktopOverlaySnapshotsEqual,
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

  it('caps participant count and all renderer-controlled strings', () => {
    const snapshot = normalizeDesktopOverlaySnapshot({
      active: true,
      channelId: 'c'.repeat(DESKTOP_OVERLAY_MAX_CHANNEL_ID_LENGTH + 10),
      channelLabel: 'l'.repeat(DESKTOP_OVERLAY_MAX_CHANNEL_LABEL_LENGTH + 10),
      participants: Array.from(
        { length: DESKTOP_OVERLAY_MAX_PARTICIPANTS + 10 },
        (_, index) => ({
          userId: `${index}${'u'.repeat(DESKTOP_OVERLAY_MAX_USER_ID_LENGTH + 10)}`,
          displayName: 'n'.repeat(DESKTOP_OVERLAY_MAX_DISPLAY_NAME_LENGTH + 10),
          avatarUrl: 'a'.repeat(DESKTOP_OVERLAY_MAX_AVATAR_URL_LENGTH + 10),
          speaking: false,
          muted: false,
          deafened: false,
        }),
      ),
    })

    expect(snapshot.channelId).toHaveLength(
      DESKTOP_OVERLAY_MAX_CHANNEL_ID_LENGTH,
    )
    expect(snapshot.channelLabel).toHaveLength(
      DESKTOP_OVERLAY_MAX_CHANNEL_LABEL_LENGTH,
    )
    expect(snapshot.participants).toHaveLength(
      DESKTOP_OVERLAY_MAX_PARTICIPANTS,
    )
    expect(snapshot.participants[0]?.userId).toHaveLength(
      DESKTOP_OVERLAY_MAX_USER_ID_LENGTH,
    )
    expect(snapshot.participants[0]?.displayName).toHaveLength(
      DESKTOP_OVERLAY_MAX_DISPLAY_NAME_LENGTH,
    )
    expect(snapshot.participants[0]?.avatarUrl).toHaveLength(
      DESKTOP_OVERLAY_MAX_AVATAR_URL_LENGTH,
    )
  })

  it('compares snapshots by their payload rather than object identity', () => {
    const first = normalizeDesktopOverlaySnapshot({
      active: true,
      channelId: 'voice-1',
      channelLabel: 'Raid voice',
      participants: [
        {
          userId: 'user-1',
          displayName: 'Mira',
          avatarUrl: null,
          speaking: false,
          muted: false,
          deafened: false,
        },
      ],
    })
    const equal = structuredClone(first)
    const changed = structuredClone(first)
    changed.participants[0]!.speaking = true

    expect(desktopOverlaySnapshotsEqual(first, equal)).toBe(true)
    expect(desktopOverlaySnapshotsEqual(first, changed)).toBe(false)
  })

})
