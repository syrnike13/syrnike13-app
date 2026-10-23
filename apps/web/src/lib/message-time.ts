import { ulidToDate } from '#/lib/ulid'

/** Группа сообщений одного автора рвётся после 7 минут. */
export const MESSAGE_GROUP_BREAK_MS = 7 * 60 * 1000

function startOfLocalDay(date: Date): number {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime()
}

export function isSameLocalDay(a: Date, b: Date): boolean {
  return startOfLocalDay(a) === startOfLocalDay(b)
}

export type MessageDayKind = 'today' | 'yesterday' | 'other'

export function messageDayKind(date: Date, now = new Date()): MessageDayKind {
  if (isSameLocalDay(date, now)) return 'today'

  const yesterday = new Date(now)
  yesterday.setDate(yesterday.getDate() - 1)
  if (isSameLocalDay(date, yesterday)) return 'yesterday'

  return 'other'
}

export function messageCreatedAt(message: { _id: string }): Date {
  return ulidToDate(message._id)
}

/** Полная дата и время для всего, что не «сегодня/вчера». */
export function formatMessageTimestamp(
  date: Date,
  locale = 'ru',
): string {
  return new Intl.DateTimeFormat(locale, {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  }).format(date)
}

export function formatMessageTimeShort(date: Date, locale = 'ru'): string {
  return new Intl.DateTimeFormat(locale, {
    hour: 'numeric',
    minute: '2-digit',
  }).format(date)
}

/** Длинная дата для разделителя дней (без «сегодня/вчера»). */
export function formatDateDividerDate(date: Date, locale = 'ru'): string {
  return new Intl.DateTimeFormat(locale, {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  }).format(date)
}

function isSystemMessage(message: { system?: unknown }) {
  return message.system != null
}

/**
 * Следующее сообщение в «хвосте» группы: тот же автор подряд, не позже
 * 7 минут, без системных, без цитаты-ответа и без embed. Embed — блочный
 * элемент: схлопнутая строка прилипает к карточке и теряет автора, поэтому
 * группа рвётся и до, и после неё.
 * (Разделитель даты сбрасывает previous в message-feed.)
 */
type CompactableMessage = {
  _id: string
  author: string
  system?: unknown
  replies?: readonly unknown[] | null
  embeds?: readonly unknown[] | null
}

export function shouldCompactMessage(
  previous: CompactableMessage | undefined,
  current: CompactableMessage,
): boolean {
  if (!previous) return false
  if (previous.author !== current.author) return false
  if (
    messageCreatedAt(current).getTime() -
      messageCreatedAt(previous).getTime() >
    MESSAGE_GROUP_BREAK_MS
  ) {
    return false
  }
  if (isSystemMessage(previous) || isSystemMessage(current)) return false
  if (current.replies?.length) return false
  if (current.embeds?.length) return false
  if (previous.embeds?.length) return false
  return true
}
