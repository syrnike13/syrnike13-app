import { describe, expect, it } from 'vitest'
import type { DesktopOverlayState } from '@syrnike13/platform'

import { overlayStateNeedsSettingsReload } from './settings-overlay-panel'

const baseState: DesktopOverlayState = {
  available: true,
  enabled: true,
  visible: false,
  target: null,
  snapshot: {
    active: false,
    channelId: null,
    channelLabel: null,
    participants: [],
  },
}

describe('overlay settings event refresh', () => {
  it('does not reload settings for snapshot, visibility, bounds, or enabled churn', () => {
    const target = {
      gameId: 'raid',
      processName: 'raid.exe',
      processPath: 'C:/Games/Raid.exe',
      title: 'Raid',
      bounds: { x: 0, y: 0, width: 1_920, height: 1_080 },
    }
    const previous = { ...baseState, target }
    const next = {
      ...previous,
      enabled: false,
      visible: true,
      target: { ...target, bounds: { ...target.bounds, x: 10 } },
      snapshot: { ...baseState.snapshot, participants: [] },
    }

    expect(overlayStateNeedsSettingsReload(previous, next)).toBe(false)
    expect(overlayStateNeedsSettingsReload(previous, baseState)).toBe(false)
    expect(overlayStateNeedsSettingsReload(null, baseState)).toBe(false)
  })

  it('reloads when availability or detected game metadata changes', () => {
    const detected = {
      ...baseState,
      target: {
        gameId: 'raid',
        processName: 'raid.exe',
        processPath: 'C:/Games/Raid.exe',
        title: 'Raid',
        bounds: { x: 0, y: 0, width: 1_920, height: 1_080 },
      },
    }

    expect(overlayStateNeedsSettingsReload(baseState, detected)).toBe(true)
    expect(
      overlayStateNeedsSettingsReload(baseState, {
        ...baseState,
        available: false,
      }),
    ).toBe(true)
  })
})
