import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'

import { describe, expect, it, vi } from 'vitest'

import {
  getCurrentDesktopMusicPresence,
  normalizeMacNowPlayingPayload,
  normalizeWindowsNowPlayingPayload,
  spotifyTrackUriFromStateText,
  watchDesktopMusicPresence,
} from './desktop-music-presence'

describe('desktop music presence', () => {
  it('normalizes Windows GSMTC payloads into music presence', () => {
    expect(
      normalizeWindowsNowPlayingPayload(
        {
          appUserModelId: 'SpotifyAB.SpotifyMusic_zpdnekdrzrea0!Spotify',
          title: 'PRAXX',
          artist: 'DK',
          albumTitle: 'NO SIGNAL',
          durationMs: 225000,
          positionMs: 15000,
          playbackStatus: 'Playing',
          externalUrl: 'https://open.spotify.com/track/1',
        },
        1781518000000,
      ),
    ).toEqual({
      provider: 'spotify',
      source: 'desktop_now_playing',
      title: 'PRAXX',
      artists: ['DK'],
      album: 'NO SIGNAL',
      externalUrl: 'https://open.spotify.com/track/1',
      durationMs: 225000,
      progressMs: 15000,
      isPlaying: true,
      observedAt: 1781518000000,
    })
  })

  it('uses the Windows payload sample timestamp instead of command completion time', () => {
    expect(
      normalizeWindowsNowPlayingPayload(
        {
          appUserModelId: 'SpotifyAB.SpotifyMusic_zpdnekdrzrea0!Spotify',
          title: 'PRAXX',
          artist: 'DK',
          durationMs: 225000,
          positionMs: 15000,
          playbackStatus: 'Playing',
          observedAt: 1781517997000,
        },
        1781518000000,
      )?.observedAt,
    ).toBe(1781517997000)
  })

  it('ignores browser media sessions instead of treating every Yandex app as music', () => {
    expect(
      normalizeWindowsNowPlayingPayload(
        {
          appUserModelId: 'YandexBrowser_yandexbrowser!App',
          title: 'YouTube Song',
          artist: 'Some Channel',
          playbackStatus: 'Playing',
          observedAt: 1781517997000,
        },
        1781518000000,
      ),
    ).toBeNull()
  })

  it('normalizes macOS Music and Spotify payloads into provider-specific presence', () => {
    expect(
      normalizeMacNowPlayingPayload(
        {
          app: 'Music',
          title: 'Song',
          artist: 'Artist',
          album: 'Album',
          durationSeconds: 120,
          positionSeconds: 10,
          playerState: 'playing',
        },
        1781518000000,
      )?.provider,
    ).toBe('apple_music')

    expect(
      normalizeMacNowPlayingPayload(
        {
          app: 'Spotify',
          title: 'Song',
          artist: 'Artist',
          durationSeconds: 120,
          positionSeconds: 10,
          playerState: 'playing',
          externalUrl: 'https://open.spotify.com/track/1',
        },
        1781518000000,
      )?.provider,
    ).toBe('spotify')
  })

  it('does not spawn OS probes when desktop music presence is disabled', async () => {
    const runCommand = vi.fn()
    await expect(
      getCurrentDesktopMusicPresence({
        platform: 'darwin',
        settings: {
          music: {
            enabled: false,
            showInProfile: true,
            providers: {
              spotify: {
                enabled: true,
                source: 'desktop_now_playing',
                resolveExternalLinks: true,
              },
              apple_music: {
                enabled: true,
                source: 'desktop_now_playing',
                resolveExternalLinks: true,
              },
              yandex_music: {
                enabled: true,
                source: 'desktop_now_playing',
                resolveExternalLinks: true,
              },
            },
          },
        },
        now: () => 1781518000000,
        runCommand,
      }),
    ).resolves.toBeNull()
    expect(runCommand).not.toHaveBeenCalled()
  })

  it('uses AppleScript on macOS when desktop music providers are enabled', async () => {
    await expect(
      getCurrentDesktopMusicPresence({
        platform: 'darwin',
        settings: {
          music: {
            enabled: true,
            showInProfile: true,
            providers: {
              spotify: {
                enabled: false,
                source: 'desktop_now_playing',
                resolveExternalLinks: true,
              },
              apple_music: {
                enabled: true,
                source: 'desktop_now_playing',
                resolveExternalLinks: true,
              },
              yandex_music: {
                enabled: false,
                source: 'desktop_now_playing',
                resolveExternalLinks: true,
              },
            },
          },
        },
        now: () => 1781518000000,
        runCommand: async () =>
          JSON.stringify({
            app: 'Music',
            title: 'Song',
            artist: 'Artist',
            durationSeconds: 120,
            positionSeconds: 10,
            playerState: 'playing',
          }),
      }),
    ).resolves.toMatchObject({
      provider: 'apple_music',
      title: 'Song',
      artists: ['Artist'],
    })
  })

  it('uses PowerShell GSMTC on Windows when desktop music providers are enabled', async () => {
    await expect(
      getCurrentDesktopMusicPresence({
        platform: 'win32',
        settings: {
          music: {
            enabled: true,
            showInProfile: true,
            providers: {
              spotify: {
                enabled: true,
                source: 'desktop_now_playing',
                resolveExternalLinks: true,
              },
              apple_music: {
                enabled: false,
                source: 'desktop_now_playing',
                resolveExternalLinks: true,
              },
              yandex_music: {
                enabled: false,
                source: 'desktop_now_playing',
                resolveExternalLinks: true,
              },
            },
          },
        },
        now: () => 1781518000000,
        runCommand: async () =>
          JSON.stringify({
            appUserModelId: 'SpotifyAB.SpotifyMusic_zpdnekdrzrea0!Spotify',
            title: 'PRAXX',
            artist: 'DK',
            playbackStatus: 'Playing',
          }),
      }),
    ).resolves.toMatchObject({
      provider: 'spotify',
      title: 'PRAXX',
      artists: ['DK'],
    })
  })

  it('clears desktop music presence when Windows reports a paused session', async () => {
    await expect(
      getCurrentDesktopMusicPresence({
        platform: 'win32',
        settings: {
          music: {
            enabled: true,
            showInProfile: true,
            providers: {
              spotify: {
                enabled: true,
                source: 'desktop_now_playing',
                resolveExternalLinks: true,
              },
              apple_music: {
                enabled: false,
                source: 'desktop_now_playing',
                resolveExternalLinks: true,
              },
              yandex_music: {
                enabled: false,
                source: 'desktop_now_playing',
                resolveExternalLinks: true,
              },
            },
          },
        },
        now: () => 1781518000000,
        runCommand: async () =>
          JSON.stringify({
            appUserModelId: 'SpotifyAB.SpotifyMusic_zpdnekdrzrea0!Spotify',
            title: 'Paused Track',
            artist: 'Artist',
            playbackStatus: 'Paused',
            artworkUrl: 'data:image/png;base64,cover',
          }),
      }),
    ).resolves.toBeNull()
  })

  it('prefers the Windows music helper when it is available', async () => {
    const runCommand = vi.fn(async () =>
      JSON.stringify({
        appUserModelId: 'SpotifyAB.SpotifyMusic_zpdnekdrzrea0!Spotify',
        title: 'Thnks fr th Mmrs',
        artist: 'Fall Out Boy',
        albumTitle: 'Infinity On High',
        playbackStatus: 'Playing',
        durationMs: 203506,
        positionMs: 132149,
        artworkUrl: 'data:image/png;base64,cover',
      }),
    )

    await expect(
      getCurrentDesktopMusicPresence({
        platform: 'win32',
        settings: {
          music: {
            enabled: true,
            showInProfile: true,
            providers: {
              spotify: {
                enabled: true,
                source: 'desktop_now_playing',
                resolveExternalLinks: true,
              },
              apple_music: {
                enabled: false,
                source: 'desktop_now_playing',
                resolveExternalLinks: true,
              },
              yandex_music: {
                enabled: false,
                source: 'desktop_now_playing',
                resolveExternalLinks: true,
              },
            },
          },
        },
        windowsHelperPath: 'C:/syrnike/syrnike-music-presence-win.exe',
        now: () => 1781518000000,
        runCommand,
      }),
    ).resolves.toMatchObject({
      provider: 'spotify',
      title: 'Thnks fr th Mmrs',
      artworkUrl: 'data:image/png;base64,cover',
    })

    expect(runCommand).toHaveBeenCalledWith(
      'C:/syrnike/syrnike-music-presence-win.exe',
      [],
      expect.any(Number),
    )
  })

  it('streams Windows helper watcher lines into normalized presence changes', async () => {
    const stdout = new PassThrough()
    const stderr = new PassThrough()
    const child = Object.assign(new EventEmitter(), {
      stdout,
      stderr,
      stdin: new PassThrough(),
      killed: false,
      kill: vi.fn(function (this: { killed: boolean }) {
        this.killed = true
        return true
      }),
    })
    const onChange = vi.fn()
    const onUnavailable = vi.fn()

    const dispose = watchDesktopMusicPresence({
      platform: 'win32',
      windowsHelperPath: 'C:/syrnike/syrnike-music-presence-win.exe',
      getSettings: () => musicSettings(),
      onChange,
      onUnavailable,
      spawnCommand: vi.fn(() => child as never),
      now: () => 1781518000000,
    })

    stdout.write(
      `${JSON.stringify({
        appUserModelId: 'SpotifyAB.SpotifyMusic_zpdnekdrzrea0!Spotify',
        title: 'Watcher Track',
        artist: 'Artist',
        playbackStatus: 'Playing',
        observedAt: 1781517999000,
      })}\n`,
    )
    await new Promise((resolve) => setImmediate(resolve))

    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: 'spotify',
        title: 'Watcher Track',
        observedAt: 1781517999000,
      }),
    )
    expect(onUnavailable).not.toHaveBeenCalled()

    dispose?.()
    expect(child.kill).toHaveBeenCalled()
  })

  it('adds a direct Spotify app URI from the Windows Spotify state when enabled', async () => {
    await expect(
      getCurrentDesktopMusicPresence({
        platform: 'win32',
        settings: {
          music: {
            enabled: true,
            showInProfile: true,
            providers: {
              spotify: {
                enabled: true,
                source: 'desktop_now_playing',
                resolveExternalLinks: true,
              },
              apple_music: {
                enabled: false,
                source: 'desktop_now_playing',
                resolveExternalLinks: true,
              },
              yandex_music: {
                enabled: false,
                source: 'desktop_now_playing',
                resolveExternalLinks: true,
              },
            },
          },
        },
        windowsHelperPath: 'C:/syrnike/syrnike-music-presence-win.exe',
        now: () => 1781518000000,
        runCommand: async () =>
          JSON.stringify({
            appUserModelId: 'SpotifyAB.SpotifyMusic_zpdnekdrzrea0!Spotify',
            title: 'Holiday / Boulevard of Broken Dreams',
            artist: 'Green Day',
            playbackStatus: 'Playing',
          }),
        readWindowsSpotifyTrackUri: (presence) =>
          presence.title === 'Holiday / Boulevard of Broken Dreams'
            ? 'spotify:track:5JHNg1hxZFT7TDEphhM4wj'
            : undefined,
      }),
    ).resolves.toMatchObject({
      provider: 'spotify',
      externalUrl: 'spotify:track:5JHNg1hxZFT7TDEphhM4wj',
    })
  })

  it('does not add a direct Spotify app URI when external link resolving is disabled', async () => {
    await expect(
      getCurrentDesktopMusicPresence({
        platform: 'win32',
        settings: {
          music: {
            enabled: true,
            showInProfile: true,
            providers: {
              spotify: {
                enabled: true,
                source: 'desktop_now_playing',
                resolveExternalLinks: false,
              },
              apple_music: {
                enabled: false,
                source: 'desktop_now_playing',
                resolveExternalLinks: true,
              },
              yandex_music: {
                enabled: false,
                source: 'desktop_now_playing',
                resolveExternalLinks: true,
              },
            },
          },
        },
        windowsHelperPath: 'C:/syrnike/syrnike-music-presence-win.exe',
        now: () => 1781518000000,
        runCommand: async () =>
          JSON.stringify({
            appUserModelId: 'SpotifyAB.SpotifyMusic_zpdnekdrzrea0!Spotify',
            title: 'Holiday / Boulevard of Broken Dreams',
            artist: 'Green Day',
            playbackStatus: 'Playing',
          }),
        readWindowsSpotifyTrackUri: () => 'spotify:track:5JHNg1hxZFT7TDEphhM4wj',
      }),
    ).resolves.toMatchObject({
      provider: 'spotify',
      externalUrl: undefined,
    })
  })

  it('falls back to the Windows PowerShell probe when the music helper fails', async () => {
    const runCommand = vi
      .fn()
      .mockRejectedValueOnce(new Error('helper unavailable'))
      .mockResolvedValueOnce(
        JSON.stringify({
          appUserModelId: 'SpotifyAB.SpotifyMusic_zpdnekdrzrea0!Spotify',
          title: 'PRAXX',
          artist: 'DK',
          playbackStatus: 'Playing',
        }),
      )

    await expect(
      getCurrentDesktopMusicPresence({
        platform: 'win32',
        settings: {
          music: {
            enabled: true,
            showInProfile: true,
            providers: {
              spotify: {
                enabled: true,
                source: 'desktop_now_playing',
                resolveExternalLinks: true,
              },
              apple_music: {
                enabled: false,
                source: 'desktop_now_playing',
                resolveExternalLinks: true,
              },
              yandex_music: {
                enabled: false,
                source: 'desktop_now_playing',
                resolveExternalLinks: true,
              },
            },
          },
        },
        windowsHelperPath: 'C:/syrnike/syrnike-music-presence-win.exe',
        now: () => 1781518000000,
        runCommand,
      }),
    ).resolves.toMatchObject({
      provider: 'spotify',
      title: 'PRAXX',
    })

    expect(runCommand).toHaveBeenCalledTimes(2)
    expect(runCommand.mock.calls[1]?.[0]).toBe('powershell.exe')
  })

  it('extracts a Spotify URI only when the state matches the current track', () => {
    const stateText = [
      'spotify:track:5JHNg1hxZFT7TDEphhM4wj',
      'title PRAXX',
      'spotify:track:3jUTjCISntIUFL8jnAjzgc',
      'album_title Billy Talent II',
      'title Fallen Leaves',
    ].join('\u0012')

    expect(
      spotifyTrackUriFromStateText(stateText, {
        title: 'Fallen Leaves',
        artists: ['Billy Talent'],
      }),
    ).toBe('spotify:track:3jUTjCISntIUFL8jnAjzgc')

    expect(
      spotifyTrackUriFromStateText(stateText, {
        title: 'Different Song',
        artists: ['Billy Talent'],
      }),
    ).toBeUndefined()
  })

  it('falls back to the latest Spotify URI when non-ASCII titles are missing from Spotify state', () => {
    const stateText = [
      'spotify:track:5JHNg1hxZFT7TDEphhM4wj',
      'artist DK',
      'spotify:track:3jUTjCISntIUFL8jnAjzgc',
    ].join('\u0012')

    expect(
      spotifyTrackUriFromStateText(stateText, {
        title: 'Криминалка',
        artists: ['DK'],
      }),
    ).toBe('spotify:track:3jUTjCISntIUFL8jnAjzgc')
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
