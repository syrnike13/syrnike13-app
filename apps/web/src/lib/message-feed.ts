import type { Message } from '@syrnike13/api-types'

import {
  formatDateDivider,
  messageCreatedAt,
  shouldCompactMessage,
} from '#/lib/message-time'

export type MessageFeedItem =
  | { type: 'date'; key: string; dateLabel: string }
  | {
      type: 'message'
      key: string
      message: Message
      compact: boolean
    }

export function buildMessageFeedItems(messages: Message[]): MessageFeedItem[] {
  const items: MessageFeedItem[] = []
  let previous: Message | undefined
  let previousDayKey: string | undefined

  for (const message of messages) {
    const created = messageCreatedAt(message)
    const dayKey = `${created.getFullYear()}-${created.getMonth()}-${created.getDate()}`

    if (dayKey !== previousDayKey) {
      items.push({
        type: 'date',
        key: `date-${dayKey}`,
        dateLabel: formatDateDivider(created),
      })
      previousDayKey = dayKey
      previous = undefined
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

export function feedItemEstimateHeight(item: MessageFeedItem): number {
  if (item.type === 'date') return 52
  if (item.type === 'message' && item.message.replies?.[0] && !item.compact) {
    return 92
  }
  return item.compact ? 26 : 72
}
