import { describe, expect, it } from 'vitest'

import {
  normalizeMusicPresence,
  normalizeMusicPresencePatch,
} from './music'

describe('music presence contract', () => {
  it('normalizes a playable desktop music presence', () => {
    expect(
      normalizeMusicPresence({
        provider: 'spotify',
        source: 'desktop_now_playing',
        title: 'PRAXX',
        artists: ['DK'],
        album: 'NO SIGNAL',
        artworkUrl: 'https://example.test/cover.jpg',
        externalUrl: 'https://open.spotify.com/track/1',
        durationMs: 225000,
        progressMs: 15000,
        isPlaying: true,
        observedAt: 1781518000000,
      }),
    ).toEqual({
      provider: 'spotify',
      source: 'desktop_now_playing',
      title: 'PRAXX',
      artists: ['DK'],
      album: 'NO SIGNAL',
      artworkUrl: 'https://example.test/cover.jpg',
      externalUrl: 'https://open.spotify.com/track/1',
      durationMs: 225000,
      progressMs: 15000,
      isPlaying: true,
      observedAt: 1781518000000,
    })
  })

  it('drops empty titles and clamps impossible progress', () => {
    expect(
      normalizeMusicPresence({
        provider: 'yandex_music',
        source: 'desktop_now_playing',
        title: '   ',
        artists: ['DK'],
        durationMs: 1000,
        progressMs: 5000,
        isPlaying: true,
        observedAt: 1,
      }),
    ).toBeNull()

    expect(
      normalizeMusicPresence({
        provider: 'apple_music',
        source: 'desktop_now_playing',
        title: 'Track',
        artists: [],
        durationMs: 1000,
        progressMs: 5000,
        isPlaying: true,
        observedAt: 1,
      })?.progressMs,
    ).toBe(1000)
  })

  it('normalizes gateway patches and accepts null as clear signal', () => {
    expect(normalizeMusicPresencePatch(null)).toBeNull()
    expect(
      normalizeMusicPresencePatch({
        provider: 'spotify',
        source: 'spotify_api',
        title: 'Ty lko tańcz',
        artists: ['New Name', 'MIŁ', 'Błoto'],
        durationMs: 163000,
        progressMs: 25000,
        isPlaying: true,
        observedAt: 1781518000000,
      }),
    ).toMatchObject({
      provider: 'spotify',
      source: 'spotify_api',
      title: 'Ty lko tańcz',
      artists: ['New Name', 'MIŁ', 'Błoto'],
    })
  })

  it('treats paused playback patches as a clear signal', () => {
    expect(
      normalizeMusicPresencePatch({
        provider: 'spotify',
        source: 'desktop_now_playing',
        title: 'Paused track',
        artists: ['Artist'],
        durationMs: 180000,
        progressMs: 60000,
        isPlaying: false,
        observedAt: 1781518000000,
      }),
    ).toBeNull()
  })
})
