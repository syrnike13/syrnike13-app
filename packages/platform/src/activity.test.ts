import { describe, expect, it } from 'vitest'

import {
  normalizeActivity,
  normalizeActivityPatch,
} from './activity'

describe('activity contract', () => {
  it('normalizes a Discord-like playing activity', () => {
    expect(
      normalizeActivity({
        activitySourceId: 'desktop:game',
        type: 'playing',
        name: 'Counter-Strike 2',
        createdAt: 1781517900000,
        observedAt: 1781518000000,
        details: 'Premier',
        state: 'Mirage',
        timestamps: { start: 1781517900000 },
        assets: {
          largeImageUrl: 'https://cdn.example.test/cs2.jpg',
          largeText: 'Counter-Strike 2',
          smallImageUrl: 'https://cdn.example.test/steam.png',
          smallText: 'Steam',
        },
        party: {
          id: 'lobby-1',
          size: { current: 3, max: 5 },
        },
      }),
    ).toEqual({
      activitySourceId: 'desktop:game',
      type: 'playing',
      name: 'Counter-Strike 2',
      createdAt: 1781517900000,
      observedAt: 1781518000000,
      details: 'Premier',
      state: 'Mirage',
      timestamps: { start: 1781517900000 },
      assets: {
        largeImageUrl: 'https://cdn.example.test/cs2.jpg',
        largeText: 'Counter-Strike 2',
        smallImageUrl: 'https://cdn.example.test/steam.png',
        smallText: 'Steam',
      },
      party: {
        id: 'lobby-1',
        size: { current: 3, max: 5 },
      },
    })
  })

  it('keeps safe URLs and strips unsafe URLs, secrets, and malformed buttons', () => {
    const activity = normalizeActivity({
      activitySourceId: 'desktop:music',
      type: 'listening',
      name: 'Spotify',
      observedAt: 1781518000000,
      url: 'https://open.spotify.com/track/1',
      detailsUrl: 'javascript:alert(1)',
      stateUrl: 'spotify:track:1',
      assets: {
        largeImageUrl: 'https://cdn.example.test/cover.jpg',
        largeUrl: 'file:///C:/secret.txt',
      },
      buttons: [
        { label: 'Open', url: 'https://open.spotify.com/track/1' },
        { label: 'Bad', url: 'javascript:alert(1)' },
        { label: '', url: 'https://example.test' },
      ],
      secrets: {
        join: 'private-lobby-secret',
      },
    })

    expect(activity).toMatchObject({
      activitySourceId: 'desktop:music',
      type: 'listening',
      name: 'Spotify',
      url: 'https://open.spotify.com/track/1',
      assets: {
        largeImageUrl: 'https://cdn.example.test/cover.jpg',
      },
      buttons: [{ label: 'Open', url: 'https://open.spotify.com/track/1' }],
    })
    expect(activity?.detailsUrl).toBeUndefined()
    expect(activity?.stateUrl).toBeUndefined()
    expect(activity?.assets?.largeUrl).toBeUndefined()
    expect((activity as Record<string, unknown> | null)?.secrets).toBeUndefined()
  })

  it('accepts raster data image URLs only for image assets', () => {
    const cover = 'data:image/png;base64,aGVsbG8='
    const activity = normalizeActivity({
      activitySourceId: 'desktop:music',
      type: 'listening',
      name: 'Spotify',
      observedAt: 1781518000000,
      assets: {
        largeImageUrl: cover,
        smallImageUrl: 'data:image/svg+xml;base64,PHN2Zy8+',
        inviteCoverImageUrl: 'data:text/html;base64,PGgxPkJhZDwvaDE+',
      },
    })

    expect(activity?.assets).toEqual({
      largeImageUrl: cover,
    })
  })

  it('rejects missing required fields and malformed activity types', () => {
    expect(
      normalizeActivity({
        type: 'playing',
        name: 'Counter-Strike 2',
        observedAt: 1,
      }),
    ).toBeNull()

    expect(
      normalizeActivity({
        activitySourceId: 'desktop:game',
        type: 'coding',
        name: 'Cursor',
        observedAt: 1,
      }),
    ).toBeNull()

    expect(
      normalizeActivity({
        activitySourceId: 'desktop:game',
        type: 'playing',
        name: '   ',
        observedAt: 1,
      }),
    ).toBeNull()
  })

  it('normalizes activity patches and accepts null as a clear signal', () => {
    expect(normalizeActivityPatch(null)).toBeNull()

    expect(
      normalizeActivityPatch({
        activitySourceId: 'desktop:game',
        type: 'playing',
        name: 'Counter-Strike 2',
        observedAt: 1781518000000,
      }),
    ).toEqual({
      activitySourceId: 'desktop:game',
      type: 'playing',
      name: 'Counter-Strike 2',
      observedAt: 1781518000000,
    })

    expect(
      normalizeActivityPatch({
        activitySourceId: 'desktop:game',
        type: 'playing',
        observedAt: 1781518000000,
      }),
    ).toBeUndefined()
  })
})
