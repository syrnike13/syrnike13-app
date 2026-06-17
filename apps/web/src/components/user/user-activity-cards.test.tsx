// @vitest-environment jsdom

import { act, cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { UserActivityCards } from '#/components/user/user-activity-cards'
import { syncStore } from '#/features/sync/sync-store'

describe('UserActivityCards', () => {
  afterEach(() => {
    cleanup()
    syncStore.reset()
    vi.useRealTimers()
  })

  it('renders current music activity with a direct Spotify app link and artwork', () => {
    syncStore.setUserActivity('user-1', {
      activitySourceId: 'desktop:music',
      type: 'listening',
      name: 'Spotify',
      details: 'PRAXX',
      state: 'DK',
      url: 'https://open.spotify.com/track/1',
      observedAt: Date.now(),
      timestamps: {
        start: Date.now() - 15_000,
        end: Date.now() + 210_000,
      },
      assets: {
        largeImageUrl: 'https://cdn.example/praxx.jpg',
        largeText: 'Kino',
      },
    })

    const { container } = render(<UserActivityCards userId="user-1" />)

    expect(screen.getByText('Слушает Spotify')).toBeTruthy()
    expect(screen.getByText('PRAXX')).toBeTruthy()
    expect(screen.getByText('DK')).toBeTruthy()
    expect(screen.getByRole('link', { name: 'Открыть' }).getAttribute('href')).toBe(
      'spotify:track:1',
    )
    expect(container.querySelector('img')?.getAttribute('src')).toBe(
      'https://cdn.example/praxx.jpg',
    )
  })

  it('renders raster data image artwork from local desktop activity', () => {
    const cover = 'data:image/png;base64,aGVsbG8='
    syncStore.setUserActivity('user-1', {
      activitySourceId: 'desktop:music',
      type: 'listening',
      name: 'Spotify',
      details: 'Track',
      state: 'Artist',
      observedAt: Date.now(),
      assets: {
        largeImageUrl: cover,
      },
    })

    const { container } = render(<UserActivityCards userId="user-1" />)

    expect(container.querySelector('img')?.getAttribute('src')).toBe(cover)
  })

  it('renders multiple activity slots in stable priority order', () => {
    syncStore.setUserActivity('user-1', {
      activitySourceId: 'desktop:music',
      type: 'listening',
      name: 'Spotify',
      details: 'Song',
      state: 'Artist',
      observedAt: Date.now(),
    })
    syncStore.setUserActivity('user-1', {
      activitySourceId: 'desktop:game',
      type: 'playing',
      name: 'Counter-Strike 2',
      applicationId: 'cs2.exe',
      observedAt: Date.now(),
    })

    render(<UserActivityCards userId="user-1" />)

    const cards = screen.getAllByRole('region')
    expect(cards[0].getAttribute('aria-label')).toBe('Играет')
    expect(cards[1].getAttribute('aria-label')).toBe('Слушает Spotify')
    expect(screen.getByText('Counter-Strike 2')).toBeTruthy()
    expect(screen.getByText('Song')).toBeTruthy()
  })

  it('renders Yandex Music search links when no track url exists', () => {
    syncStore.setUserActivity('user-1', {
      activitySourceId: 'desktop:music',
      type: 'listening',
      name: 'Yandex Music',
      details: 'Тает лёд',
      state: 'Грибы',
      observedAt: Date.now(),
    })

    render(<UserActivityCards userId="user-1" />)

    expect(screen.getByRole('link', { name: 'Открыть' }).getAttribute('href')).toBe(
      `yandexmusic://search?text=${encodeURIComponent('Грибы Тает лёд')}`,
    )
  })

  it('updates the timestamp progress while the activity is active', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(1_000_000)
    syncStore.setUserActivity('user-1', {
      activitySourceId: 'desktop:music',
      type: 'listening',
      name: 'Spotify',
      details: 'Timer',
      state: 'Artist',
      observedAt: Date.now(),
      timestamps: {
        start: Date.now() - 15_000,
        end: Date.now() + 165_000,
      },
    })

    render(<UserActivityCards userId="user-1" />)

    expect(screen.getByText('0:15')).toBeTruthy()

    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000)
    })

    expect(screen.getByText('0:17')).toBeTruthy()
  })

  it('renders nothing without activities', () => {
    const { container } = render(<UserActivityCards userId="user-1" />)

    expect(container.firstChild).toBeNull()
  })
})
