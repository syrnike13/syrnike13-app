import { describe, expect, it } from 'vitest'

import {
  createDesktopOverlayState,
  updateDesktopOverlayEnabled,
  updateDesktopOverlayGameTarget,
  updateDesktopOverlaySnapshot,
} from './overlay-manager'

const snapshot = {
  active: true,
  channelId: 'voice-1',
  channelLabel: 'General voice',
  participants: [
    {
      userId: 'user-1',
      displayName: 'Mira',
      avatarUrl: null,
      speaking: true,
      muted: false,
      deafened: false,
    },
  ],
}

const target = {
  gameId: 'c:/games/raid.exe',
  processName: 'raid.exe',
  processPath: 'C:/Games/Raid.exe',
  title: 'Raid',
  bounds: { x: 0, y: 0, width: 1920, height: 1080 },
}

const enabledPreferences = {
  enabled: true,
  games: [
    {
      id: 'c:/games/raid.exe',
      processName: 'raid.exe',
      processPath: 'C:/Games/Raid.exe',
      title: 'Raid',
      enabled: true,
      lastSeenAt: 123,
    },
  ],
}

describe('desktop overlay manager state', () => {
  it('is unavailable outside Windows', () => {
    expect(createDesktopOverlayState('linux')).toEqual({
      available: false,
      enabled: false,
      visible: false,
      target: null,
      snapshot: {
        active: false,
        channelId: null,
        channelLabel: null,
        participants: [],
      },
    })
  })

  it('stays hidden until a detected game target is active', () => {
    const voiceState = updateDesktopOverlaySnapshot(
      createDesktopOverlayState('win32'),
      snapshot,
      enabledPreferences,
    )

    expect(voiceState.visible).toBe(false)
    expect(
      updateDesktopOverlayGameTarget(voiceState, target, enabledPreferences),
    ).toEqual({
      available: true,
      enabled: true,
      visible: true,
      target,
      snapshot,
    })
  })

  it('does not show for a detected game disabled in overlay settings', () => {
    const voiceState = updateDesktopOverlaySnapshot(
      createDesktopOverlayState('win32'),
      snapshot,
      enabledPreferences,
    )

    expect(
      updateDesktopOverlayGameTarget(voiceState, target, {
        enabled: true,
        games: [{ ...enabledPreferences.games[0], enabled: false }],
      }).visible,
    ).toBe(false)
  })

  it('uses the supplied overlay settings when updating snapshots and enabled state', () => {
    const disabledSettings = {
      enabled: true,
      games: [{ ...enabledPreferences.games[0], enabled: false }],
    }
    const gameState = updateDesktopOverlayGameTarget(
      createDesktopOverlayState('win32'),
      target,
      enabledPreferences,
    )

    expect(
      updateDesktopOverlaySnapshot(gameState, snapshot, disabledSettings).visible,
    ).toBe(false)
    expect(
      updateDesktopOverlayEnabled(
        { ...gameState, snapshot },
        true,
        disabledSettings,
      ).visible,
    ).toBe(false)
  })
})
