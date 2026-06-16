import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { MusicPresencePatch } from '@syrnike13/platform'

vi.mock('electron', () => ({
  ipcMain: {
    handle: vi.fn(),
    removeHandler: vi.fn(),
  },
}))

describe('desktop music presence IPC service', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('registers the current presence IPC handler', async () => {
    const { ipcMain } = await import('electron')
    const { IPC } = await import('@syrnike13/platform')
    const { registerDesktopMusicPresenceIpc } = await import(
      './desktop-music-presence-service'
    )

    const dispose = registerDesktopMusicPresenceIpc(() => null, {
      getSettings: () => musicSettings(),
      probeMusicPresence: async () => null,
      pollIntervalMs: 0,
    })

    expect(ipcMain.handle).toHaveBeenCalledWith(
      IPC.musicGetCurrentPresence,
      expect.any(Function),
    )
    dispose()
  })

  it('removes the current presence IPC handler during dispose', async () => {
    const { ipcMain } = await import('electron')
    const { IPC } = await import('@syrnike13/platform')
    const { registerDesktopMusicPresenceIpc } = await import(
      './desktop-music-presence-service'
    )

    const dispose = registerDesktopMusicPresenceIpc(() => null, {
      getSettings: () => musicSettings(),
      probeMusicPresence: async () => null,
      pollIntervalMs: 0,
    })

    dispose()

    expect(ipcMain.removeHandler).toHaveBeenCalledWith(
      IPC.musicGetCurrentPresence,
    )
  })

  it('sends presence changes to the renderer during polling', async () => {
    vi.useFakeTimers()
    try {
      const { IPC } = await import('@syrnike13/platform')
      const { registerDesktopMusicPresenceIpc } = await import(
        './desktop-music-presence-service'
      )
      const send = vi.fn()
      const dispose = registerDesktopMusicPresenceIpc(
        () =>
          ({
            webContents: { send },
          }) as never,
        {
          getSettings: () => musicSettings(),
          probeMusicPresence: async () => ({
            provider: 'spotify',
            source: 'desktop_now_playing',
            title: 'PRAXX',
            artists: ['DK'],
            isPlaying: true,
            observedAt: 1781518000000,
          }),
          watchMusicPresence: () => null,
          pollIntervalMs: 10,
        },
      )

      await vi.advanceTimersByTimeAsync(10)

      expect(send).toHaveBeenCalledWith(
        IPC.musicPresenceChanged,
        expect.objectContaining({
          provider: 'spotify',
          title: 'PRAXX',
        }),
      )
      dispose()
    } finally {
      vi.useRealTimers()
    }
  })

  it('sends watcher presence changes immediately and skips polling while watcher is active', async () => {
    vi.useFakeTimers()
    try {
      const { IPC } = await import('@syrnike13/platform')
      const { registerDesktopMusicPresenceIpc } = await import(
        './desktop-music-presence-service'
      )
      const send = vi.fn()
      const probeMusicPresence = vi.fn(async () => null)
      let emitPresence:
        | ((presence: Awaited<ReturnType<typeof probeMusicPresence>>) => void)
        | undefined
      const disposeWatcher = vi.fn()

      const dispose = registerDesktopMusicPresenceIpc(
        () =>
          ({
            webContents: { send },
          }) as never,
        {
          getSettings: () => musicSettings(),
          probeMusicPresence,
          watchMusicPresence: ({ onChange }) => {
            emitPresence = onChange
            return disposeWatcher
          },
        },
      )

      emitPresence?.({
        provider: 'spotify',
        source: 'desktop_now_playing',
        title: 'Watcher Track',
        artists: ['Artist'],
        isPlaying: true,
        observedAt: 1781518000000,
      })
      await vi.advanceTimersByTimeAsync(1_000)

      expect(send).toHaveBeenCalledWith(
        IPC.musicPresenceChanged,
        expect.objectContaining({
          title: 'Watcher Track',
        }),
      )
      expect(probeMusicPresence).not.toHaveBeenCalled()
      dispose()
      expect(disposeWatcher).toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })

  it('keeps watcher artwork when progress updates omit artwork for the same track', async () => {
    const { IPC } = await import('@syrnike13/platform')
    const { registerDesktopMusicPresenceIpc } = await import(
      './desktop-music-presence-service'
    )
    const send = vi.fn()
    let emitPresence: ((presence: MusicPresencePatch) => void) | undefined

    const dispose = registerDesktopMusicPresenceIpc(
      () =>
        ({
          webContents: { send },
        }) as never,
      {
        getSettings: () => musicSettings(),
        watchMusicPresence: ({ onChange }) => {
          emitPresence = onChange
          return vi.fn()
        },
      },
    )

    emitPresence?.({
      provider: 'spotify',
      source: 'desktop_now_playing',
      title: 'Watcher Track',
      artists: ['Artist'],
      artworkUrl: 'data:image/png;base64,cover',
      progressMs: 1_000,
      isPlaying: true,
      observedAt: 1781518000000,
    })
    emitPresence?.({
      provider: 'spotify',
      source: 'desktop_now_playing',
      title: 'Watcher Track',
      artists: ['Artist'],
      progressMs: 2_000,
      isPlaying: true,
      observedAt: 1781518001000,
    })

    expect(send).toHaveBeenLastCalledWith(
      IPC.musicPresenceChanged,
      expect.objectContaining({
        title: 'Watcher Track',
        artworkUrl: 'data:image/png;base64,cover',
        progressMs: 2_000,
      }),
    )
    dispose()
  })

  it('keeps watcher external urls when progress updates omit links for the same track', async () => {
    const { IPC } = await import('@syrnike13/platform')
    const { registerDesktopMusicPresenceIpc } = await import(
      './desktop-music-presence-service'
    )
    const send = vi.fn()
    let emitPresence: ((presence: MusicPresencePatch) => void) | undefined

    const dispose = registerDesktopMusicPresenceIpc(
      () =>
        ({
          webContents: { send },
        }) as never,
      {
        getSettings: () => musicSettings(),
        watchMusicPresence: ({ onChange }) => {
          emitPresence = onChange
          return vi.fn()
        },
      },
    )

    emitPresence?.({
      provider: 'spotify',
      source: 'desktop_now_playing',
      title: 'Watcher Track',
      artists: ['Artist'],
      externalUrl: 'spotify:track:5JHNg1hxZFT7TDEphhM4wj',
      progressMs: 1_000,
      isPlaying: true,
      observedAt: 1781518000000,
    })
    emitPresence?.({
      provider: 'spotify',
      source: 'desktop_now_playing',
      title: 'Watcher Track',
      artists: ['Artist'],
      progressMs: 2_000,
      isPlaying: true,
      observedAt: 1781518001000,
    })

    expect(send).toHaveBeenLastCalledWith(
      IPC.musicPresenceChanged,
      expect.objectContaining({
        title: 'Watcher Track',
        externalUrl: 'spotify:track:5JHNg1hxZFT7TDEphhM4wj',
        progressMs: 2_000,
      }),
    )
    dispose()
  })

  it('polls music presence often enough for pause and track changes to feel live', async () => {
    vi.useFakeTimers()
    try {
      const { IPC } = await import('@syrnike13/platform')
      const { registerDesktopMusicPresenceIpc } = await import(
        './desktop-music-presence-service'
      )
      const send = vi.fn()
      const dispose = registerDesktopMusicPresenceIpc(
        () =>
          ({
            webContents: { send },
          }) as never,
        {
          getSettings: () => musicSettings(),
          probeMusicPresence: async () => ({
            provider: 'spotify',
            source: 'desktop_now_playing',
            title: 'Fast',
            artists: ['Artist'],
            isPlaying: true,
            observedAt: 1781518000000,
          }),
          watchMusicPresence: () => null,
        },
      )

      await vi.advanceTimersByTimeAsync(1_000)

      expect(send).toHaveBeenCalledWith(
        IPC.musicPresenceChanged,
        expect.objectContaining({
          title: 'Fast',
        }),
      )
      dispose()
    } finally {
      vi.useRealTimers()
    }
  })
})

function musicSettings() {
  return {
    music: {
      enabled: true,
      showInProfile: true,
      providers: {
        spotify: {
          enabled: true,
          source: 'desktop_now_playing' as const,
          resolveExternalLinks: true,
        },
        apple_music: {
          enabled: false,
          source: 'desktop_now_playing' as const,
          resolveExternalLinks: true,
        },
        yandex_music: {
          enabled: false,
          source: 'desktop_now_playing' as const,
          resolveExternalLinks: true,
        },
      },
    },
  }
}
