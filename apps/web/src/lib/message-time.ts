import { ulidToDate } from '#/lib/ulid'

const MESSAGE_GROUP_WINDOW_MS = 7 * 60 * 1000

function startOfLocalDay(date: Date): number {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime()
}

function isSameLocalDay(a: Date, b: Date): boolean {
  return startOfLocalDay(a) === startOfLocalDay(b)
}

export function messageCreatedAt(message: { _id: string }): Date {
  return ulidToDate(message._id)
}

export function formatMessageTimestamp(date: Date): string {
  return new Intl.DateTimeFormat('ru-RU', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  }).format(date)
}

export function formatMessageTimeShort(date: Date): string {
  return new Intl.DateTimeFormat('ru-RU', {
    hour: 'numeric',
    minute: '2-digit',
  }).format(date)
}

export function formatDateDivider(date: Date): string {
  const now = new Date()
  const yesterday = new Date(now)
  yesterday.setDate(yesterday.getDate() - 1)

  if (isSameLocalDay(date, now)) return 'Сегодня'
  if (isSameLocalDay(date, yesterday)) return 'Вчера'

  return new Intl.DateTimeFormat('ru-RU', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  }).format(date)
}

function isSystemMessage(message: { system?: unknown }) {
  return message.system != null
}

/**
 * Следующее сообщение в «хвосте» группы: тот же автор подряд, без системных и без цитаты-ответа.
 * (Разделитель даты сбрасывает previous в message-feed.)
 */
export function shouldCompactMessage(
  previous:
    | { _id: string; author: string; system?: unknown; replies?: readonly unknown[] | null }
    | undefined,
  current: { _id: string; author: string; system?: unknown; replies?: readonly unknown[] | null },
): boolean {
  if (!previous) return false
  if (previous.author !== current.author) return false
  if (isSystemMessage(previous) || isSystemMessage(current)) return false
  if (current.replies?.length) return false
  if (
    Math.abs(
      messageCreatedAt(current).getTime() - messageCreatedAt(previous).getTime(),
    ) > MESSAGE_GROUP_WINDOW_MS
  ) {
    return false
  }
  return true
}
