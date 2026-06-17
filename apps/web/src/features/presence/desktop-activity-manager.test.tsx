// @vitest-environment jsdom
import { act, cleanup, render, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type {
  DesktopOverlayState,
  MusicPresencePatch,
  SyrnikeDesktopApi,
} from '@syrnike13/platform'

import {
  DESKTOP_GAME_ACTIVITY_SOURCE_ID,
  DESKTOP_MUSIC_ACTIVITY_SOURCE_ID,
  DesktopActivityManager,
  musicPresenceToActivity,
  overlayGameTargetToActivity,
} from './desktop-activity-manager'

const emptyOverlayState: DesktopOverlayState = {
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

const mockState = vi.hoisted(() => {
  const state: {
    activity: ReturnType<typeof vi.fn>
    setUserActivity: ReturnType<typeof vi.fn>
    desktop: Pick<SyrnikeDesktopApi, 'music' | 'overlay'> | null
    musicHandler: ((presence: MusicPresencePatch) => void) | null
    overlayHandler: ((state: DesktopOverlayState) => void) | null
  } = {
    activity: vi.fn(),
    setUserActivity: vi.fn(),
    desktop: null,
    musicHandler: null,
    overlayHandler: null,
  }
  return state
})

vi.mock('#/features/auth/auth-context', () => ({
  useAuth: () => ({
    user: { _id: 'user-1' },
  }),
}))

vi.mock('#/platform/use-platform', () => ({
  usePlatform: () => ({
    desktop: mockState.desktop,
  }),
}))

vi.mock('#/features/events/gateway', () => ({
  eventsGateway: {
    activity: mockState.activity,
  },
}))

vi.mock('#/features/sync/sync-store', () => ({
  syncStore: {
    setUserActivity: mockState.setUserActivity,
  },
}))

describe('DesktopActivityManager', () => {
  afterEach(() => {
    cleanup()
    vi.useRealTimers()
    mockState.desktop = null
    mockState.musicHandler = null
    mockState.overlayHandler = null
    mockState.activity.mockReset()
    mockState.setUserActivity.mockReset()
  })

  it('publishes current desktop music as an activity slot on mount', async () => {
    mockState.desktop = createDesktopApi({
      currentMusic: {
        provider: 'spotify',
        source: 'desktop_now_playing',
        title: 'PRAXX',
        artists: ['DK'],
        album: 'Street Album',
        externalUrl: 'https://open.spotify.com/track/1',
        durationMs: 225000,
        progressMs: 15000,
        isPlaying: true,
        observedAt: 1781518000000,
      },
    })

    render(<DesktopActivityManager />)

    await waitFor(() => {
      expect(mockState.activity).toHaveBeenCalledWith(
        expect.objectContaining({
          activitySourceId: DESKTOP_MUSIC_ACTIVITY_SOURCE_ID,
          type: 'listening',
          name: 'Spotify',
          details: 'PRAXX',
          state: 'DK',
        }),
        DESKTOP_MUSIC_ACTIVITY_SOURCE_ID,
      )
      expect(mockState.setUserActivity).toHaveBeenCalledWith(
        'user-1',
        expect.objectContaining({
          activitySourceId: DESKTOP_MUSIC_ACTIVITY_SOURCE_ID,
          details: 'PRAXX',
        }),
        DESKTOP_MUSIC_ACTIVITY_SOURCE_ID,
      )
    })
  })

  it('keeps Spotify track links when desktop detection returns an app URI', () => {
    const activity = musicPresenceToActivity({
      provider: 'spotify',
      source: 'desktop_now_playing',
      title: 'Track',
      artists: ['Artist'],
      externalUrl: 'spotify:track:5JHNg1hxZFT7TDEphhM4wj',
      isPlaying: true,
      observedAt: 1781518000000,
    })

    expect(activity).toEqual(
      expect.objectContaining({
        activitySourceId: DESKTOP_MUSIC_ACTIVITY_SOURCE_ID,
        type: 'listening',
        name: 'Spotify',
        url: 'https://open.spotify.com/track/5JHNg1hxZFT7TDEphhM4wj',
      }),
    )
  })

  it('publishes overlay game target as a separate activity slot', async () => {
    mockState.desktop = createDesktopApi({
      currentOverlay: {
        ...emptyOverlayState,
        target: {
          gameId: 'c:/users/jakel/games/raid.exe',
          processName: 'Raid.exe',
          processPath: 'C:/Users/JAKEL/Games/Raid.exe',
          title: 'Raid',
          bounds: { x: 0, y: 0, width: 1920, height: 1080 },
        },
      },
    })

    render(<DesktopActivityManager />)

    await waitFor(() => {
      expect(mockState.activity).toHaveBeenCalledWith(
        expect.objectContaining({
          activitySourceId: DESKTOP_GAME_ACTIVITY_SOURCE_ID,
          type: 'playing',
          name: 'Raid',
        }),
        DESKTOP_GAME_ACTIVITY_SOURCE_ID,
      )
    })
  })

  it('does not leak local game paths into game activity payloads', () => {
    const activity = overlayGameTargetToActivity(
      {
        gameId: 'c:/users/jakel/games/raid.exe',
        processName: 'Raid.exe',
        processPath: 'C:/Users/JAKEL/Games/Raid.exe',
        title: 'Raid',
        bounds: { x: 0, y: 0, width: 1920, height: 1080 },
      },
      1781518000000,
    )

    expect(JSON.stringify(activity).toLowerCase()).not.toContain(
      'c:/users/jakel',
    )
    expect(activity.applicationId).toBeUndefined()
  })

  it('attaches a verified game id only for curated game identities', () => {
    const activity = overlayGameTargetToActivity(
      {
        gameId: 'c:/program files (x86)/steam/steamapps/common/counter-strike global offensive/game/bin/win64/cs2.exe',
        processName: 'cs2.exe',
        processPath:
          'C:/Program Files (x86)/Steam/steamapps/common/Counter-Strike Global Offensive/game/bin/win64/cs2.exe',
        title: 'Counter-Strike 2',
        bounds: { x: 0, y: 0, width: 1920, height: 1080 },
      },
      1781518000000,
    )

    expect(activity).toEqual(
      expect.objectContaining({
        activitySourceId: DESKTOP_GAME_ACTIVITY_SOURCE_ID,
        type: 'playing',
        name: 'Counter-Strike 2',
        applicationId: 'steam:730',
      }),
    )
  })

  it('renews active activity slots on heartbeat', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(1_000_000)
    mockState.desktop = createDesktopApi({
      currentOverlay: {
        ...emptyOverlayState,
        target: {
          gameId: 'c:/games/cs2.exe',
          processName: 'cs2.exe',
          processPath: 'C:/Games/cs2.exe',
          title: 'Counter-Strike 2',
          bounds: { x: 0, y: 0, width: 1920, height: 1080 },
        },
      },
    })

    render(<DesktopActivityManager />)

    await act(async () => {
      await Promise.resolve()
    })

    mockState.activity.mockClear()

    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000)
    })

    expect(mockState.activity).toHaveBeenCalledWith(
      expect.objectContaining({
        activitySourceId: DESKTOP_GAME_ACTIVITY_SOURCE_ID,
        type: 'playing',
        name: 'Counter-Strike 2',
        applicationId: 'steam:730',
        observedAt: 1_030_000,
      }),
      DESKTOP_GAME_ACTIVITY_SOURCE_ID,
    )
  })

  it('keeps a live music update when the initial probe resolves later', async () => {
    let resolveInitialMusic = (_presence: MusicPresencePatch) => {}
    const initialMusic = new Promise<MusicPresencePatch>((resolve) => {
      resolveInitialMusic = resolve
    })
    mockState.desktop = createDesktopApi({
      currentMusic: () => initialMusic,
    })

    render(<DesktopActivityManager />)

    await waitFor(() => {
      expect(mockState.musicHandler).toEqual(expect.any(Function))
    })

    mockState.musicHandler?.({
      provider: 'apple_music',
      source: 'desktop_now_playing',
      title: 'Fresh song',
      artists: ['Artist'],
      isPlaying: true,
      observedAt: 1781518010000,
    })
    resolveInitialMusic({
      provider: 'spotify',
      source: 'desktop_now_playing',
      title: 'Stale song',
      artists: ['Artist'],
      isPlaying: true,
      observedAt: 1781518000000,
    })
    await initialMusic

    await waitFor(() => {
      expect(mockState.activity).toHaveBeenCalledTimes(2)
    })
    expect(mockState.activity).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'Apple Music',
        details: 'Fresh song',
      }),
      DESKTOP_MUSIC_ACTIVITY_SOURCE_ID,
    )
  })

  it('publishes null when desktop reports paused playback', async () => {
    mockState.desktop = createDesktopApi({
      currentMusic: {
        provider: 'spotify',
        source: 'desktop_now_playing',
        title: 'Paused track',
        artists: ['Artist'],
        isPlaying: false,
        observedAt: 1781518000000,
      },
    })

    render(<DesktopActivityManager />)

    await waitFor(() => {
      expect(mockState.activity).toHaveBeenCalledWith(
        null,
        DESKTOP_MUSIC_ACTIVITY_SOURCE_ID,
      )
      expect(mockState.setUserActivity).toHaveBeenCalledWith(
        'user-1',
        null,
        DESKTOP_MUSIC_ACTIVITY_SOURCE_ID,
      )
    })
  })
})

function createDesktopApi(options?: {
  currentMusic?: MusicPresencePatch | (() => Promise<MusicPresencePatch>)
  currentOverlay?: DesktopOverlayState
}): Pick<SyrnikeDesktopApi, 'music' | 'overlay'> {
  return {
    music: {
      getCurrentPresence: () => {
        const currentMusic = options?.currentMusic ?? null
        return typeof currentMusic === 'function'
          ? currentMusic()
          : Promise.resolve(currentMusic)
      },
      onPresenceChange: (handler) => {
        mockState.musicHandler = handler
        return () => {
          mockState.musicHandler = null
        }
      },
    },
    overlay: {
      getState: () => Promise.resolve(options?.currentOverlay ?? emptyOverlayState),
      setEnabled: async () => options?.currentOverlay ?? emptyOverlayState,
      setSnapshot: async () => options?.currentOverlay ?? emptyOverlayState,
      onStateChange: (handler) => {
        mockState.overlayHandler = handler
        return () => {
          mockState.overlayHandler = null
        }
      },
    },
  }
}
