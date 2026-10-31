import type { Message } from '@syrnike13/api-types'

import {
  formatDateDividerDate,
  messageCreatedAt,
  shouldCompactMessage,
} from './message-time'

export type MessageFeedItem =
  | { type: 'date'; key: string; dateLabel: string }
  | { type: 'unread'; key: string; messageId: string }
  | {
      type: 'message'
      key: string
      message: Message
      compact: boolean
    }

type BuildMessageFeedOptions = {
  /** Первое непрочитанное сообщение: перед ним ставится divider. */
  unreadMessageId?: string | null
  formatDateLabel?: (date: Date) => string
}

export function buildMessageFeedItems(
  messages: Message[],
  options: BuildMessageFeedOptions = {},
): MessageFeedItem[] {
  const { unreadMessageId, formatDateLabel = formatDateDividerDate } = options
  const items: MessageFeedItem[] = []
  let previous: Message | undefined
  let previousDayKey: string | undefined
  let unreadInserted = false

  for (const message of messages) {
    const created = messageCreatedAt(message)
    const dayKey = `${created.getFullYear()}-${created.getMonth()}-${created.getDate()}`

    if (dayKey !== previousDayKey) {
      items.push({
        type: 'date',
        key: `date-${dayKey}`,
        dateLabel: formatDateLabel(created),
      })
      previousDayKey = dayKey
      previous = undefined
    }

    if (!unreadInserted && unreadMessageId === message._id) {
      items.push({
        type: 'unread',
        key: `unread-${message._id}`,
        messageId: message._id,
      })
      unreadInserted = true
    }

    const compact = shouldCompactMessage(previous, message)
    items.push({
      type: 'message',
      key: message._id,
      message,
      compact,
    })
    previous = message
  }

  return items
}
