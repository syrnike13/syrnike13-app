// @vitest-environment jsdom

import type { Channel } from '@syrnike13/api-types'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  MUTE_DURATIONS,
  MUTE_FOREVER_LABEL,
  channelMuteStorageKey,
  channelNotificationLevel,
  emptyNotificationMutes,
  formatMuteUntilLabel,
  hasExpiredMute,
  isChannelMuted,
  loadNotificationMutes,
  normalizeNotificationMutes,
  notificationLevelLabel,
  persistNotificationMutes,
  resolveMessageNotificationLevel,
} from '#/features/notifications/channel-mute-store'
import { syncStore } from '#/features/sync/sync-store'

const serverChannel = {
  _id: 'text-general',
  channel_type: 'TextChannel',
  server: 'server-1',
  name: 'general',
} as Channel

const dmChannel = {
  _id: 'dm-1',
  channel_type: 'DirectMessage',
  active: true,
  recipients: ['user-1', 'user-2'],
} as Channel

describe('notification mute state', () => {
  it('drops expired mutes and empty entries on normalize', () => {
    const now = 1_000_000
    const mutes = normalizeNotificationMutes(
      {
        channels: {
          expired: { mutedUntil: now - 1 },
          forever: { mutedUntil: 'forever' },
          level: { level: 'mentions' },
          empty: {},
        },
        servers: { 'server-1': 'none' },
        hideMuted: { 'server-1': true },
      },
      now,
    )

    expect(Object.keys(mutes.channels).sort()).toEqual(['forever', 'level'])
    expect(mutes.channels.forever).toEqual({ mutedUntil: 'forever' })
    expect(mutes.channels.level).toEqual({ level: 'mentions' })
    expect(mutes.servers).toEqual({ 'server-1': 'none' })
    expect(mutes.hideMuted).toEqual({ 'server-1': true })
  })

  it('keeps partial payloads and broken json out of the way', () => {
    expect(normalizeNotificationMutes(null)).toEqual(emptyNotificationMutes())
    expect(loadNotificationMutes(undefined)).toEqual(emptyNotificationMutes())

    window.localStorage.setItem(channelMuteStorageKey('user-1'), '{oops')
    expect(loadNotificationMutes('user-1')).toEqual(emptyNotificationMutes())

    window.localStorage.setItem(
      channelMuteStorageKey('user-1'),
      JSON.stringify({ channels: { 'text-general': { level: 'mentions' } } }),
    )
    expect(loadNotificationMutes('user-1')).toEqual({
      channels: { 'text-general': { level: 'mentions' } },
      servers: {},
      hideMuted: {},
    })
  })

  it('sees an expired numeric mute even when the entry keeps a level', () => {
    const now = 1_000_000

    expect(
      hasExpiredMute(
        normalizeNotificationMutes(
          { channels: { aaa: { level: 'none', mutedUntil: now - 1 } } },
          now,
        ),
        now,
      ),
    ).toBe(false)
    expect(
      hasExpiredMute(
        { channels: { aaa: { level: 'none', mutedUntil: now - 1 } }, servers: {}, hideMuted: {} },
        now,
      ),
    ).toBe(true)
    expect(
      hasExpiredMute(
        { channels: { aaa: { mutedUntil: now + 1_000 } }, servers: {}, hideMuted: {} },
        now,
      ),
    ).toBe(false)
    expect(
      hasExpiredMute(
        { channels: { aaa: { mutedUntil: 'forever' } }, servers: {}, hideMuted: {} },
        now,
      ),
    ).toBe(false)
  })

  it('does not leak one account mutes into another', () => {
    persistNotificationMutes('user-1', {
      ...emptyNotificationMutes(),
      channels: { 'text-general': { mutedUntil: 'forever' } },
    })

    expect(isChannelMuted(loadNotificationMutes('user-1'), 'text-general')).toBe(
      true,
    )
    expect(isChannelMuted(loadNotificationMutes('user-2'), 'text-general')).toBe(
      false,
    )
  })

  it('treats a future mute and forever as muted, a past one as expired', () => {
    const now = 1_000_000
    const mutes = normalizeNotificationMutes(
      {
        channels: {
          future: { mutedUntil: now + 60_000 },
          past: { mutedUntil: now - 1 },
          forever: { mutedUntil: 'forever' },
        },
      },
      now,
    )

    expect(isChannelMuted(mutes, 'future', now)).toBe(true)
    expect(isChannelMuted(mutes, 'past', now)).toBe(false)
    expect(isChannelMuted(mutes, 'forever', now)).toBe(true)
    expect(isChannelMuted(mutes, 'unknown', now)).toBe(false)
  })

  it('prefers the channel level over the server level and mutes over both', () => {
    const mutes = {
      channels: {
        'text-general': { level: 'all' as const },
        muted: { mutedUntil: 'forever' as const },
      },
      servers: { 'server-1': 'mentions' as const },
      hideMuted: {},
    }

    // Переопределение канала важнее уровня сервера.
    expect(channelNotificationLevel(mutes, serverChannel)).toBe('all')
    // Сервер глушит каналы без переопределения.
    expect(
      channelNotificationLevel(mutes, {
        ...serverChannel,
        _id: 'text-other',
      } as Channel),
    ).toBe('mentions')
    // Активный мьют сильнее любого уровня.
    expect(
      channelNotificationLevel(mutes, { ...serverChannel, _id: 'muted' } as Channel),
    ).toBe('none')
    // Личные сообщения серверный уровень не задевает.
    expect(channelNotificationLevel(mutes, dmChannel)).toBe('all')
  })

  it('resolves the message notification level for mentions-only channels', () => {
    const mutes = {
      ...emptyNotificationMutes(),
      servers: { 'server-1': 'mentions' as const },
    }

    expect(
      resolveMessageNotificationLevel({
        mutes,
        channel: serverChannel,
        mentionsCurrentUser: false,
      }),
    ).toBe('none')
    expect(
      resolveMessageNotificationLevel({
        mutes,
        channel: serverChannel,
        mentionsCurrentUser: true,
      }),
    ).toBe('mentions')
    expect(
      resolveMessageNotificationLevel({
        mutes,
        channel: dmChannel,
        mentionsCurrentUser: false,
      }),
    ).toBe('all')
    expect(
      resolveMessageNotificationLevel({
        mutes,
        channel: undefined,
        mentionsCurrentUser: false,
      }),
    ).toBe('all')
  })

  it('formats the mute end date and the forever label', () => {
    const now = new Date(2026, 9, 13, 12, 0, 0).getTime()
    const until = new Date(2026, 9, 13, 12, 55, 0).getTime()

    expect(formatMuteUntilLabel('forever', now)).toBe(
      'Заглушено до тех пор, пока не включу',
    )
    expect(formatMuteUntilLabel(until, now)).toBe('Заглушено до 13.10, 12:55')
    expect(formatMuteUntilLabel(now - 1, now)).toBeNull()
    expect(formatMuteUntilLabel(undefined, now)).toBeNull()
  })

  it('offers the mute durations from the reference menu', () => {
    expect(MUTE_DURATIONS.map((option) => option.label)).toEqual([
      'На 15 минут',
      'На 1 час',
      'На 3 часа',
      'На 8 часов',
      'На 24 часа',
    ])
    expect(MUTE_DURATIONS.find((option) => option.id === '3h')?.ms).toBe(
      3 * 60 * 60 * 1000,
    )
    expect(MUTE_FOREVER_LABEL).toBe('До тех пор, пока не включу')
  })

  it('labels the notification levels for the submenu caption', () => {
    expect(notificationLevelLabel('all')).toBe('Все сообщения')
    expect(notificationLevelLabel('mentions')).toBe('Только @упоминания')
    expect(notificationLevelLabel('none')).toBe('Ничего')
  })
})

describe('sync store channel mutes', () => {
  beforeEach(() => {
    syncStore.reset()
    window.localStorage.clear()
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
    syncStore.reset()
    window.localStorage.clear()
  })

  it('stores, persists and clears a channel mute', () => {
    syncStore.setCurrentUserId('user-1')
    syncStore.setChannelMute('text-general', 15 * 60_000)

    expect(
      isChannelMuted(syncStore.getState().notificationMutes, 'text-general'),
    ).toBe(true)
    expect(
      isChannelMuted(loadNotificationMutes('user-1'), 'text-general'),
    ).toBe(true)

    syncStore.setChannelMute('text-general', null)

    expect(
      isChannelMuted(syncStore.getState().notificationMutes, 'text-general'),
    ).toBe(false)
    expect(
      syncStore.getState().notificationMutes.channels['text-general'],
    ).toBeUndefined()
  })

  it('clears an expired mute by itself so the badge comes back', () => {
    syncStore.setCurrentUserId('user-1')
    syncStore.setChannelMute('text-general', 60_000)

    expect(
      syncStore.getState().notificationMutes.channels['text-general'],
    ).toEqual({ mutedUntil: expect.any(Number) })

    vi.advanceTimersByTime(60_000 + 500)

    expect(
      syncStore.getState().notificationMutes.channels['text-general'],
    ).toBeUndefined()
  })

  it('keeps the notification level when all mutes are cleared', () => {
    syncStore.setCurrentUserId('user-1')
    syncStore.setChannelNotificationLevel('text-general', 'mentions')
    syncStore.setChannelMute('text-general', 'forever')

    syncStore.clearAllChannelMutes()

    expect(
      syncStore.getState().notificationMutes.channels['text-general'],
    ).toEqual({ level: 'mentions' })
  })

  it('re-arms the timer for the next mute when the first one expires', () => {
    syncStore.setCurrentUserId('user-1')
    syncStore.setChannelNotificationLevel('aaa', 'none')
    syncStore.setChannelMute('aaa', 60_000)
    syncStore.setChannelMute('bbb', 120_000)

    // 'aaa' теряет мьют, но сохраняет уровень — по числу ключей это не видно.
    vi.advanceTimersByTime(60_000 + 500)

    expect(syncStore.getState().notificationMutes.channels['aaa']).toEqual({
      level: 'none',
    })
    expect(
      isChannelMuted(syncStore.getState().notificationMutes, 'bbb'),
    ).toBe(true)

    vi.advanceTimersByTime(60_000 + 500)

    expect(
      syncStore.getState().notificationMutes.channels['bbb'],
    ).toBeUndefined()
  })

  it('resets mutes on logout without touching the stored keys', () => {
    syncStore.setCurrentUserId('user-1')
    syncStore.setChannelMute('text-general', 'forever')

    syncStore.reset()

    expect(syncStore.getState().notificationMutes).toEqual(
      emptyNotificationMutes(),
    )
    expect(
      isChannelMuted(loadNotificationMutes('user-1'), 'text-general'),
    ).toBe(true)
  })
})
