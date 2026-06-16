// @vitest-environment jsdom
import { cleanup, render, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { SyrnikeDesktopApi, MusicPresencePatch } from '@syrnike13/platform'

import { MusicPresenceManager } from './music-presence-manager'

const mockState = vi.hoisted(() => {
  const state: {
    musicPresence: ReturnType<typeof vi.fn>
    setUserMusicPresence: ReturnType<typeof vi.fn>
    desktop: Pick<SyrnikeDesktopApi, 'music'> | null
    presenceHandler: ((presence: MusicPresencePatch) => void) | null
  } = {
    musicPresence: vi.fn(),
    setUserMusicPresence: vi.fn(),
    desktop: null,
    presenceHandler: null,
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
    musicPresence: mockState.musicPresence,
  },
}))

vi.mock('#/features/sync/sync-store', () => ({
  syncStore: {
    setUserMusicPresence: mockState.setUserMusicPresence,
  },
}))

describe('MusicPresenceManager', () => {
  afterEach(() => {
    cleanup()
    mockState.desktop = null
    mockState.presenceHandler = null
    mockState.musicPresence.mockReset()
    mockState.setUserMusicPresence.mockReset()
  })

  it('publishes the current desktop music presence on mount', async () => {
    mockState.desktop = {
      music: {
        getCurrentPresence: async () => ({
          provider: 'spotify',
          source: 'desktop_now_playing',
          title: 'PRAXX',
          artists: ['DK'],
          isPlaying: true,
          observedAt: 1781518000000,
        }),
        onPresenceChange: (handler) => {
          mockState.presenceHandler = handler
          return () => {
            mockState.presenceHandler = null
          }
        },
      },
    }

    render(<MusicPresenceManager />)

    await waitFor(() => {
      expect(mockState.musicPresence).toHaveBeenCalledWith(
        expect.objectContaining({
          provider: 'spotify',
          title: 'PRAXX',
        }),
      )
      expect(mockState.setUserMusicPresence).toHaveBeenCalledWith(
        'user-1',
        expect.objectContaining({
          provider: 'spotify',
          title: 'PRAXX',
        }),
      )
    })
  })

  it('publishes desktop music presence changes', async () => {
    mockState.desktop = {
      music: {
        getCurrentPresence: async () => null,
        onPresenceChange: (handler) => {
          mockState.presenceHandler = handler
          return () => {
            mockState.presenceHandler = null
          }
        },
      },
    }

    render(<MusicPresenceManager />)

    await waitFor(() => {
      expect(mockState.presenceHandler).toEqual(expect.any(Function))
    })

    mockState.presenceHandler?.({
      provider: 'apple_music',
      source: 'desktop_now_playing',
      title: 'Song',
      artists: ['Artist'],
      isPlaying: true,
      observedAt: 1781518000000,
    })

    expect(mockState.musicPresence).toHaveBeenLastCalledWith(
      expect.objectContaining({
        provider: 'apple_music',
        title: 'Song',
      }),
    )
    expect(mockState.setUserMusicPresence).toHaveBeenLastCalledWith(
      'user-1',
      expect.objectContaining({
        provider: 'apple_music',
        title: 'Song',
      }),
    )
  })

  it('keeps a live update when the initial desktop probe resolves later', async () => {
    let resolveInitialPresence = (_presence: MusicPresencePatch) => {}
    const initialPresence = new Promise<MusicPresencePatch>((resolve) => {
      resolveInitialPresence = resolve
    })
    mockState.desktop = {
      music: {
        getCurrentPresence: () => initialPresence,
        onPresenceChange: (handler) => {
          mockState.presenceHandler = handler
          return () => {
            mockState.presenceHandler = null
          }
        },
      },
    }

    render(<MusicPresenceManager />)

    await waitFor(() => {
      expect(mockState.presenceHandler).toEqual(expect.any(Function))
    })

    mockState.presenceHandler?.({
      provider: 'apple_music',
      source: 'desktop_now_playing',
      title: 'Fresh song',
      artists: ['Artist'],
      isPlaying: true,
      observedAt: 1781518010000,
    })
    resolveInitialPresence({
      provider: 'spotify',
      source: 'desktop_now_playing',
      title: 'Stale song',
      artists: ['Artist'],
      isPlaying: true,
      observedAt: 1781518000000,
    })
    await initialPresence

    await waitFor(() => {
      expect(mockState.musicPresence).toHaveBeenCalledTimes(1)
    })
    expect(mockState.musicPresence).toHaveBeenLastCalledWith(
      expect.objectContaining({
        provider: 'apple_music',
        title: 'Fresh song',
      }),
    )
    expect(mockState.setUserMusicPresence).toHaveBeenLastCalledWith(
      'user-1',
      expect.objectContaining({
        provider: 'apple_music',
        title: 'Fresh song',
      }),
    )
  })

  it('continues publishing listener updates when the initial desktop probe rejects', async () => {
    const initialError = new Error('probe failed')
    mockState.desktop = {
      music: {
        getCurrentPresence: () => Promise.reject(initialError),
        onPresenceChange: (handler) => {
          mockState.presenceHandler = handler
          return () => {
            mockState.presenceHandler = null
          }
        },
      },
    }

    render(<MusicPresenceManager />)

    await waitFor(() => {
      expect(mockState.presenceHandler).toEqual(expect.any(Function))
    })

    mockState.presenceHandler?.({
      provider: 'spotify',
      source: 'desktop_now_playing',
      title: 'Listener song',
      artists: ['Artist'],
      isPlaying: true,
      observedAt: 1781518010000,
    })

    await waitFor(() => {
      expect(mockState.musicPresence).toHaveBeenCalledWith(
        expect.objectContaining({
          provider: 'spotify',
          title: 'Listener song',
        }),
      )
    })
  })

  it('publishes null when desktop reports paused playback', async () => {
    mockState.desktop = {
      music: {
        getCurrentPresence: async () => ({
          provider: 'spotify',
          source: 'desktop_now_playing',
          title: 'Paused track',
          artists: ['Artist'],
          durationMs: 180000,
          progressMs: 60000,
          isPlaying: false,
          observedAt: 1781518000000,
        }),
        onPresenceChange: (handler) => {
          mockState.presenceHandler = handler
          return () => {
            mockState.presenceHandler = null
          }
        },
      },
    }

    render(<MusicPresenceManager />)

    await waitFor(() => {
      expect(mockState.musicPresence).toHaveBeenCalledWith(null)
      expect(mockState.setUserMusicPresence).toHaveBeenCalledWith(
        'user-1',
        null,
      )
    })

    mockState.presenceHandler?.({
      provider: 'spotify',
      source: 'desktop_now_playing',
      title: 'Paused track',
      artists: ['Artist'],
      durationMs: 180000,
      progressMs: 70000,
      isPlaying: false,
      observedAt: 1781518010000,
    })

    expect(mockState.musicPresence).toHaveBeenLastCalledWith(null)
    expect(mockState.setUserMusicPresence).toHaveBeenLastCalledWith(
      'user-1',
      null,
    )
  })
})
