// @vitest-environment jsdom

import { act, cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { UserMusicPresenceCard } from '#/components/user/user-music-presence-card'
import { syncStore } from '#/features/sync/sync-store'

describe('UserMusicPresenceCard', () => {
  afterEach(() => {
    cleanup()
    syncStore.reset()
    vi.useRealTimers()
  })

  it('renders current music presence with a direct Spotify app link and artwork', () => {
    syncStore.setUserMusicPresence('user-1', {
      provider: 'spotify',
      source: 'desktop_now_playing',
      title: 'PRAXX',
      artists: ['DK'],
      album: 'Kino',
      artworkUrl: 'https://cdn.example/praxx.jpg',
      externalUrl: 'https://open.spotify.com/track/1',
      durationMs: 225000,
      progressMs: 15000,
      isPlaying: true,
      observedAt: Date.now(),
    })

    const { container } = render(<UserMusicPresenceCard userId="user-1" />)

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

  it('renders a Yandex Music search link when no track url exists', () => {
    syncStore.setUserMusicPresence('user-1', {
      provider: 'yandex_music',
      source: 'desktop_now_playing',
      title: 'Тает лёд',
      artists: ['Грибы'],
      durationMs: 180000,
      progressMs: 30000,
      isPlaying: true,
      observedAt: Date.now(),
    })

    render(<UserMusicPresenceCard userId="user-1" />)

    expect(screen.getByRole('link', { name: 'Открыть' }).getAttribute('href')).toBe(
      `yandexmusic://search?text=${encodeURIComponent('Грибы Тает лёд')}`,
    )
  })

  it('formats zero playback progress as 0:00', () => {
    vi.useFakeTimers()
    vi.setSystemTime(1_000_000)
    syncStore.setUserMusicPresence('user-1', {
      provider: 'spotify',
      source: 'desktop_now_playing',
      title: 'Intro',
      artists: ['Artist'],
      durationMs: 60000,
      progressMs: 0,
      isPlaying: true,
      observedAt: Date.now(),
    })

    render(<UserMusicPresenceCard userId="user-1" />)

    expect(screen.getByText('0:00')).toBeTruthy()
  })

  it('filters unsafe outbound music links', () => {
    syncStore.setUserMusicPresence('user-1', {
      provider: 'spotify',
      source: 'desktop_now_playing',
      title: 'Bad Link',
      artists: ['Artist'],
      externalUrl: 'javascript:alert(1)',
      isPlaying: true,
      observedAt: Date.now(),
    })

    render(<UserMusicPresenceCard userId="user-1" />)

    expect(screen.queryByRole('link')).toBeNull()
  })

  it('keeps safe http music links', () => {
    syncStore.setUserMusicPresence('user-1', {
      provider: 'apple_music',
      source: 'desktop_now_playing',
      title: 'Safe Link',
      artists: ['Artist'],
      externalUrl: 'https://music.apple.com/album/1?i=2',
      isPlaying: true,
      observedAt: Date.now(),
    })

    render(<UserMusicPresenceCard userId="user-1" />)

    expect(screen.getByRole('link').getAttribute('href')).toBe(
      'https://music.apple.com/album/1?i=2',
    )
  })

  it('renders Yandex Music track links as app links', () => {
    syncStore.setUserMusicPresence('user-1', {
      provider: 'yandex_music',
      source: 'desktop_now_playing',
      title: 'Safe Link',
      artists: ['Artist'],
      externalUrl: 'https://music.yandex.ru/album/1/track/2',
      isPlaying: true,
      observedAt: Date.now(),
    })

    render(<UserMusicPresenceCard userId="user-1" />)

    expect(screen.getByRole('link', { name: 'Открыть' }).getAttribute('href')).toBe(
      'yandexmusic://album/1/track/2',
    )
  })

  it('renders Yandex Music track-only links as app links', () => {
    syncStore.setUserMusicPresence('user-1', {
      provider: 'yandex_music',
      source: 'desktop_now_playing',
      title: 'Safe Link',
      artists: ['Artist'],
      externalUrl: 'https://music.yandex.ru/track/2',
      isPlaying: true,
      observedAt: Date.now(),
    })

    render(<UserMusicPresenceCard userId="user-1" />)

    expect(screen.getByRole('link', { name: 'Открыть' }).getAttribute('href')).toBe(
      'yandexmusic://track/2',
    )
  })

  it('updates the playback timer while the track is playing', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(1_000_000)
    syncStore.setUserMusicPresence('user-1', {
      provider: 'spotify',
      source: 'desktop_now_playing',
      title: 'Timer',
      artists: ['Artist'],
      durationMs: 180000,
      progressMs: 15000,
      isPlaying: true,
      observedAt: Date.now(),
    })

    render(<UserMusicPresenceCard userId="user-1" />)

    expect(screen.getByText('0:15')).toBeTruthy()

    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000)
    })

    expect(screen.getByText('0:17')).toBeTruthy()
  })

  it('keeps long track names readable without squeezing playback progress', () => {
    const longTitle =
      'Очень длинное название трека, которое аккуратно занимает две строки в профиле'
    syncStore.setUserMusicPresence('user-1', {
      provider: 'spotify',
      source: 'desktop_now_playing',
      title: longTitle,
      artists: ['DK', 'TXT', 'Очень длинный исполнитель'],
      durationMs: 220000,
      progressMs: 110000,
      isPlaying: true,
      observedAt: Date.now(),
    })

    render(<UserMusicPresenceCard userId="user-1" />)

    const title = screen.getByText(longTitle)
    expect(title.className).toContain('line-clamp-2')
    expect(title.getAttribute('title')).toBe(longTitle)

    const progress = screen.getByRole('progressbar', {
      name: 'Прогресс трека',
    })
    expect(progress.getAttribute('aria-valuemin')).toBe('0')
    expect(progress.getAttribute('aria-valuemax')).toBe('100')
    expect(progress.getAttribute('aria-valuenow')).toBe('50')
  })

  it('renders nothing without music presence', () => {
    const { container } = render(<UserMusicPresenceCard userId="user-1" />)

    expect(container.firstChild).toBeNull()
  })
})
