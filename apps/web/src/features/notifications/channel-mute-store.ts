import type { Channel } from '@syrnike13/api-types'
import { Option, Schema } from 'effect'

import { serverChannelServerId } from '#/lib/channel-voice'

/** Уровень уведомлений канала или сервера. */
export type NotificationLevel = 'all' | 'mentions' | 'none'

/** `'forever'` — «до выключения мьюта». */
export type ChannelMuteExpiry = number | 'forever'

export type ChannelMuteEntry = {
  level?: NotificationLevel
  mutedUntil?: ChannelMuteExpiry
}

/**
 * Локальные настройки уведомлений текущего пользователя.
 *
 * Живут в `SyncState` и в localStorage, на сервер не уезжают: у бэкенда такого
 * поля нет, поэтому мьюты не синхронизируются между устройствами.
 */
export type NotificationMuteState = {
  /** channelId → переопределение уровня и/или мьют. */
  channels: Record<string, ChannelMuteEntry>
  /** serverId → уровень для всех каналов сервера. */
  servers: Record<string, NotificationLevel>
  /** Скрывать в сайдбаре каналы с активным мьютом. */
  hideMuted: boolean
}

export const MUTE_DURATIONS = [
  { id: '15m', label: '15 минут', ms: 15 * 60 * 1000 },
  { id: '1h', label: '1 час', ms: 60 * 60 * 1000 },
  { id: '8h', label: '8 часов', ms: 8 * 60 * 60 * 1000 },
  { id: '24h', label: '24 часа', ms: 24 * 60 * 60 * 1000 },
] as const

export function emptyNotificationMutes(): NotificationMuteState {
  return { channels: {}, servers: {}, hideMuted: false }
}

export function channelMuteStorageKey(userId: string) {
  return `syrnike13-channel-mutes:${userId}`
}

const NotificationLevelSchema = Schema.Literals(['all', 'mentions', 'none'])
const ChannelMuteExpirySchema = Schema.Union([
  Schema.Number,
  Schema.Literal('forever'),
])
const ChannelMuteEntrySchema = Schema.Struct({
  level: Schema.optionalKey(NotificationLevelSchema),
  mutedUntil: Schema.optionalKey(ChannelMuteExpirySchema),
})
/** Все поля опциональны: частичный или старый payload не должен терять настройки. */
const NotificationMuteStateSchema = Schema.Struct({
  channels: Schema.optionalKey(
    Schema.Record(Schema.String, ChannelMuteEntrySchema),
  ),
  servers: Schema.optionalKey(
    Schema.Record(Schema.String, NotificationLevelSchema),
  ),
  hideMuted: Schema.optionalKey(Schema.Boolean),
})
const NotificationMuteStateJsonSchema = Schema.fromJsonString(
  NotificationMuteStateSchema,
)

type StoredNotificationMutes = {
  channels?: Record<string, ChannelMuteEntry>
  servers?: Record<string, NotificationLevel>
  hideMuted?: boolean
}

/** Отбрасывает истёкшие мьюты и пустые записи. */
export function normalizeNotificationMutes(
  value: StoredNotificationMutes | null | undefined,
  now = Date.now(),
): NotificationMuteState {
  const channels: Record<string, ChannelMuteEntry> = {}

  for (const [channelId, entry] of Object.entries(value?.channels ?? {})) {
    if (!channelId || channelId.length > 512) continue

    const level = entry?.level
    const keepLevel =
      level === 'all' || level === 'mentions' || level === 'none'
    const mutedUntil = entry?.mutedUntil
    const keepMute =
      mutedUntil === 'forever' ||
      (typeof mutedUntil === 'number' && mutedUntil > now)

    if (!keepLevel && !keepMute) continue

    channels[channelId] = {
      ...(keepLevel ? { level } : {}),
      ...(keepMute ? { mutedUntil } : {}),
    }
  }

  return {
    channels,
    servers: { ...(value?.servers ?? {}) },
    hideMuted: value?.hideMuted === true,
  }
}

export function loadNotificationMutes(
  userId: string | undefined,
  now = Date.now(),
): NotificationMuteState {
  if (typeof window === 'undefined' || !userId) return emptyNotificationMutes()

  try {
    const raw = window.localStorage.getItem(channelMuteStorageKey(userId))
    if (!raw) return emptyNotificationMutes()

    const decoded = Schema.decodeUnknownOption(
      NotificationMuteStateJsonSchema,
    )(raw)
    if (Option.isNone(decoded)) return emptyNotificationMutes()

    return normalizeNotificationMutes(decoded.value, now)
  } catch {
    return emptyNotificationMutes()
  }
}

export function persistNotificationMutes(
  userId: string | undefined,
  mutes: NotificationMuteState,
) {
  if (typeof window === 'undefined' || !userId) return

  try {
    window.localStorage.setItem(
      channelMuteStorageKey(userId),
      Schema.encodeSync(NotificationMuteStateJsonSchema)(mutes),
    )
  } catch {
    // Приватный режим или переполнение квоты: настройки просто не переживут перезагрузку.
  }
}

export function isChannelMuted(
  mutes: NotificationMuteState,
  channelId: string,
  now = Date.now(),
) {
  const mutedUntil = mutes.channels[channelId]?.mutedUntil
  if (mutedUntil === 'forever') return true
  return typeof mutedUntil === 'number' && mutedUntil > now
}

/**
 * Эффективный уровень канала: активный мьют глушит всё, дальше переопределение
 * канала важнее уровня сервера, как в Discord.
 */
export function channelNotificationLevel(
  mutes: NotificationMuteState,
  channel: Channel,
  now = Date.now(),
): NotificationLevel {
  if (isChannelMuted(mutes, channel._id, now)) return 'none'

  const channelLevel = mutes.channels[channel._id]?.level
  if (channelLevel) return channelLevel

  const serverId = serverChannelServerId(channel)
  if (serverId) return mutes.servers[serverId] ?? 'all'

  return 'all'
}

export function serverNotificationLevel(
  mutes: NotificationMuteState,
  serverId: string,
): NotificationLevel {
  return mutes.servers[serverId] ?? 'all'
}

export function messageMentionsUser(
  message: { mentions?: readonly string[] | null },
  currentUserId: string | undefined,
) {
  if (!currentUserId) return false
  return Boolean(message.mentions?.includes(currentUserId))
}

/**
 * Глушить ли всплывашку по сообщению: `'none'` — молчим, `'mentions'` —
 * только если сообщение упоминает пользователя.
 */
export function resolveMessageNotificationLevel({
  mutes,
  channel,
  mentionsCurrentUser,
  now = Date.now(),
}: {
  mutes: NotificationMuteState
  channel: Channel | undefined
  mentionsCurrentUser: boolean
  now?: number
}): NotificationLevel {
  if (!channel) return 'all'

  const level = channelNotificationLevel(mutes, channel, now)
  if (level === 'mentions' && !mentionsCurrentUser) return 'none'
  return level
}

/** Ближайшее истечение мьюта — по нему ставится один таймер. */
export function nextMuteExpiryAt(
  mutes: NotificationMuteState,
  now = Date.now(),
): number | null {
  let next: number | null = null

  for (const entry of Object.values(mutes.channels)) {
    const mutedUntil = entry.mutedUntil
    if (typeof mutedUntil !== 'number' || mutedUntil <= now) continue
    if (next === null || mutedUntil < next) next = mutedUntil
  }

  return next
}

export function formatMuteRemaining(
  mutedUntil: ChannelMuteExpiry | undefined,
  now = Date.now(),
): string | null {
  if (mutedUntil === undefined) return null
  if (mutedUntil === 'forever') return 'до выключения'

  const remaining = mutedUntil - now
  if (remaining <= 0) return null

  const minutes = Math.max(1, Math.round(remaining / 60_000))
  if (minutes < 60) return `${minutes} мин`

  const hours = Math.round(minutes / 60)
  if (hours < 24) return `${hours} ч`

  return `${Math.round(hours / 24)} дн`
}

export function withChannelMuteEntry(
  channels: Record<string, ChannelMuteEntry>,
  channelId: string,
  entry: ChannelMuteEntry | null,
): Record<string, ChannelMuteEntry> {
  const next = { ...channels }

  if (!entry || (entry.level === undefined && entry.mutedUntil === undefined)) {
    delete next[channelId]
    return next
  }

  next[channelId] = entry
  return next
}

/** Снимает мьюты, оставляя выбранные уровни уведомлений. */
export function withoutChannelMutes(
  channels: Record<string, ChannelMuteEntry>,
): Record<string, ChannelMuteEntry> {
  const next: Record<string, ChannelMuteEntry> = {}

  for (const [channelId, entry] of Object.entries(channels)) {
    if (entry.level !== undefined) next[channelId] = { level: entry.level }
  }

  return next
}

export function mutedChannelIds(
  mutes: NotificationMuteState,
  now = Date.now(),
): string[] {
  return Object.keys(mutes.channels).filter((channelId) =>
    isChannelMuted(mutes, channelId, now),
  )
}
