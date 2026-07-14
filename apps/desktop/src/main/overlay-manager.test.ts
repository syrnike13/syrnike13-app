import { beforeEach, describe, expect, it, vi } from 'vitest'

const detectorMocks = vi.hoisted(() => ({
  dispose: vi.fn(),
  start: vi.fn(),
}))

vi.mock('./overlay-game-detector', () => ({
  disposeOverlayGameDetector: detectorMocks.dispose,
  rememberDetectedOverlayGame: vi.fn((settings: unknown) => settings),
  startOverlayGameDetector: detectorMocks.start,
}))

import {
  DESKTOP_OVERLAY_PARTICIPANT_GAP,
  DESKTOP_OVERLAY_PARTICIPANT_HEIGHT,
  DESKTOP_OVERLAY_RECOVERY_LIMIT,
  DESKTOP_OVERLAY_RECOVERY_WINDOW_MS,
  DESKTOP_OVERLAY_TARGET_INSET,
  DESKTOP_OVERLAY_WINDOW_PADDING,
  DESKTOP_OVERLAY_WINDOW_WIDTH,
  calculateDesktopOverlayWindowBounds,
  configureDesktopOverlay,
  createDesktopOverlayState,
  disposeDesktopOverlay,
  nextDesktopOverlayRecoveryFailures,
  shouldRunDesktopOverlayDetector,
  setDesktopOverlaySnapshot,
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
      screensharing: false,
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
  beforeEach(() => {
    disposeDesktopOverlay()
    detectorMocks.dispose.mockClear()
    detectorMocks.start.mockClear()
  })

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

  it('runs detection only while an enabled Windows overlay has active voice', () => {
    const inactive = createDesktopOverlayState('win32')
    const active = updateDesktopOverlaySnapshot(
      inactive,
      snapshot,
      enabledPreferences,
    )

    expect(
      shouldRunDesktopOverlayDetector(inactive, enabledPreferences),
    ).toBe(false)
    expect(shouldRunDesktopOverlayDetector(active, enabledPreferences)).toBe(
      true,
    )
    expect(
      shouldRunDesktopOverlayDetector(active, {
        ...enabledPreferences,
        enabled: false,
      }),
    ).toBe(false)
    expect(
      shouldRunDesktopOverlayDetector(
        { ...active, enabled: false },
        enabledPreferences,
      ),
    ).toBe(false)
  })

  it('starts and stops the detector as voice demand appears and disappears', () => {
    const platformDescriptor = Object.getOwnPropertyDescriptor(
      process,
      'platform',
    )!
    try {
      Object.defineProperty(process, 'platform', { value: 'win32' })
      disposeDesktopOverlay()
      detectorMocks.dispose.mockClear()

      configureDesktopOverlay('https://app.example', () => null, {
        settings: enabledPreferences,
      })
      expect(detectorMocks.start).not.toHaveBeenCalled()

      setDesktopOverlaySnapshot(snapshot)
      expect(detectorMocks.start).toHaveBeenCalledTimes(1)

      setDesktopOverlaySnapshot(snapshot)
      expect(detectorMocks.start).toHaveBeenCalledTimes(1)

      setDesktopOverlaySnapshot({
        active: false,
        channelId: null,
        channelLabel: null,
        participants: [],
      })
      expect(detectorMocks.dispose).toHaveBeenCalledTimes(1)
    } finally {
      Object.defineProperty(process, 'platform', platformDescriptor)
    }
  })

  it('uses a compact top-left window sized for the rendered participant rows', () => {
    expect(
      calculateDesktopOverlayWindowBounds(target.bounds, 3),
    ).toEqual({
      x: DESKTOP_OVERLAY_TARGET_INSET,
      y: DESKTOP_OVERLAY_TARGET_INSET,
      width: DESKTOP_OVERLAY_WINDOW_WIDTH,
      height:
        DESKTOP_OVERLAY_WINDOW_PADDING * 2 +
        DESKTOP_OVERLAY_PARTICIPANT_HEIGHT * 3 +
        DESKTOP_OVERLAY_PARTICIPANT_GAP * 2,
    })
  })

  it.each([1.25, 1.5])(
    'converts physical detector bounds to DIP at %sx scale',
    (scale) => {
      expect(
        calculateDesktopOverlayWindowBounds(
          { x: 250, y: 125, width: 2_400, height: 1_350 },
          2,
          {
            toDipPoint: ({ x, y }) => ({ x: x / scale, y: y / scale }),
            getScaleFactor: () => scale,
          },
        ),
      ).toEqual({
        x: Math.round(250 / scale) + DESKTOP_OVERLAY_TARGET_INSET,
        y: Math.round(125 / scale) + DESKTOP_OVERLAY_TARGET_INSET,
        width: DESKTOP_OVERLAY_WINDOW_WIDTH,
        height:
          DESKTOP_OVERLAY_WINDOW_PADDING * 2 +
          DESKTOP_OVERLAY_PARTICIPANT_HEIGHT * 2 +
          DESKTOP_OVERLAY_PARTICIPANT_GAP,
      })
    },
  )

  it('preserves negative multi-monitor coordinates and clamps to a small target', () => {
    expect(
      calculateDesktopOverlayWindowBounds(
        { x: -1_920, y: -200, width: 300, height: 90 },
        8,
      ),
    ).toEqual({
      x: -1_904,
      y: -184,
      width: 284,
      height: 74,
    })
  })

  it('uses one display scale when a target ends on a mixed-DPI boundary', () => {
    expect(
      calculateDesktopOverlayWindowBounds(
        { x: 2_260, y: 0, width: 300, height: 150 },
        1,
        {
          toDipPoint: ({ x, y }) => ({
            x: x >= 2_560 ? x : x / 1.5,
            y: y / 1.5,
          }),
          getScaleFactor: () => 1.5,
        },
      ),
    ).toEqual({
      x: 1_523,
      y: 16,
      width: 184,
      height: 80,
    })
  })

  it('limits automatic renderer recovery attempts inside the watchdog window', () => {
    let failures: number[] = []
    for (let index = 0; index < DESKTOP_OVERLAY_RECOVERY_LIMIT; index += 1) {
      failures = nextDesktopOverlayRecoveryFailures(failures, index)!
    }

    expect(nextDesktopOverlayRecoveryFailures(failures, 10)).toBeNull()
    expect(
      nextDesktopOverlayRecoveryFailures(
        failures,
        DESKTOP_OVERLAY_RECOVERY_WINDOW_MS + 10,
      ),
    ).toEqual([DESKTOP_OVERLAY_RECOVERY_WINDOW_MS + 10])
  })
})
