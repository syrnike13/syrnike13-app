import type { Channel } from '@syrnike13/api-types'
import { Option, Schema } from 'effect'

import { serverChannelServerId } from '#/lib/channel-voice'

/** Уровень уведомлений канала или сервера. */
export type NotificationLevel = 'all' | 'mentions' | 'none'

export const NOTIFICATION_LEVELS = [
  { value: 'all', label: 'Все сообщения' },
  { value: 'mentions', label: 'Только @упоминания' },
  { value: 'none', label: 'Ничего' },
] as const satisfies ReadonlyArray<{
  value: NotificationLevel
  label: string
}>

/** Подпись текущего уровня — для строки «Параметры уведомлений». */
export function notificationLevelLabel(level: NotificationLevel): string {
  return (
    NOTIFICATION_LEVELS.find((option) => option.value === level)?.label ??
    NOTIFICATION_LEVELS[0].label
  )
}

/** `'forever'` — «до тех пор, пока не включу». */
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
  /** serverId → скрывать ли в сайдбаре каналы с активным мьютом. */
  hideMuted: Record<string, boolean>
}

export const MUTE_DURATIONS = [
  { id: '15m', label: 'На 15 минут', ms: 15 * 60 * 1000 },
  { id: '1h', label: 'На 1 час', ms: 60 * 60 * 1000 },
  { id: '3h', label: 'На 3 часа', ms: 3 * 60 * 60 * 1000 },
  { id: '8h', label: 'На 8 часов', ms: 8 * 60 * 60 * 1000 },
  { id: '24h', label: 'На 24 часа', ms: 24 * 60 * 60 * 1000 },
] as const

/** Последний пункт подменю мьюта — без срока. */
export const MUTE_FOREVER_LABEL = 'До тех пор, пока не включу'

export function emptyNotificationMutes(): NotificationMuteState {
  return { channels: {}, servers: {}, hideMuted: {} }
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
  hideMuted: Schema.optionalKey(
    Schema.Record(Schema.String, Schema.Boolean),
  ),
})
const NotificationMuteStateJsonSchema = Schema.fromJsonString(
  NotificationMuteStateSchema,
)

type StoredNotificationMutes = {
  channels?: Record<string, ChannelMuteEntry>
  servers?: Record<string, NotificationLevel>
  hideMuted?: Record<string, boolean>
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
    hideMuted: Object.fromEntries(
      Object.entries(value?.hideMuted ?? {}).filter(([, hide]) => hide === true),
    ),
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

export function isServerHidingMuted(
  mutes: NotificationMuteState,
  serverId: string,
) {
  return mutes.hideMuted[serverId] === true
}

/**
 * Есть ли истёкший числовой мьют. Нужен, чтобы не сравнивать число ключей:
 * у записи с `level` ключ остаётся, и по длине объекта истечение не видно.
 */
export function hasExpiredMute(
  mutes: NotificationMuteState,
  now = Date.now(),
) {
  return Object.values(mutes.channels).some(
    (entry) =>
      typeof entry.mutedUntil === 'number' && entry.mutedUntil <= now,
  )
}

/**
 * Глушить ли всплывашку по сообщению: `'none'` — молчим, `'mentions'` —
 * только если сообщение упоминает пользователя.
 *
 * Упоминание считает `isMessageMentioningUser` из `#/lib/mentions`
 * (личный `mentions`, роли, @everyone/@online) — здесь только уровень.
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

/**
 * Подпись к пункту «Включить оповещения канала»: когда мьют снимется сам.
 * Бессрочный мьют даты не имеет, поэтому подпись без времени.
 */
export function formatMuteUntilLabel(
  mutedUntil: ChannelMuteExpiry | undefined,
  now = Date.now(),
): string | null {
  if (mutedUntil === undefined) return null
  if (mutedUntil === 'forever') {
    return 'Заглушено до тех пор, пока не включу'
  }
  if (mutedUntil <= now) return null

  const date = new Date(mutedUntil)
  const day = date.getDate()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const hours = String(date.getHours()).padStart(2, '0')
  const minutes = String(date.getMinutes()).padStart(2, '0')

  return `Заглушено до ${day}.${month}, ${hours}:${minutes}`
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
