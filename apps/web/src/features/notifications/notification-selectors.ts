import type { Channel } from '@syrnike13/api-types'

import { channelNotificationLevel } from '#/features/notifications/channel-mute-store'
import {
  channelUnreadMentionCount,
  isChannelUnread,
  listServerChannels,
  listUsersByRelationship,
} from '#/features/sync/selectors'
import type { SyncState } from '#/features/sync/types'

export type NotificationBadgeState = {
  count: number
  hasUnread: boolean
  urgent: boolean
}

export const EMPTY_NOTIFICATION_BADGE: NotificationBadgeState = {
  count: 0,
  hasUnread: false,
  urgent: false,
}

function badge(count: number, urgent = false): NotificationBadgeState {
  return {
    count,
    hasUnread: count > 0,
    urgent,
  }
}

function hasChannelNotification(state: SyncState, channel: Channel) {
  const unread = state.unreads[channel._id]
  return (
    isChannelUnread(channel, unread) ||
    channelUnreadMentionCount(unread) > 0
  )
}

/**
 * Канал с учётом локального мьюта и уровня уведомлений:
 * `none` — молчит, `mentions` — только упоминания.
 */
function channelNotificationSummary(state: SyncState, channel: Channel) {
  const level = channelNotificationLevel(state.notificationMutes, channel)
  if (level === 'none') return { mentions: 0, notifies: false }

  const mentions = channelUnreadMentionCount(state.unreads[channel._id])
  if (level === 'mentions') return { mentions, notifies: mentions > 0 }

  return { mentions, notifies: hasChannelNotification(state, channel) }
}
export function selectFriendRequestNotificationBadge(
  state: SyncState,
  currentUserId?: string,
): NotificationBadgeState {
  return badge(
    listUsersByRelationship(state, 'Incoming', currentUserId).length,
  )
}

export function selectHomeNotificationBadge(
  state: SyncState,
  currentUserId?: string,
): NotificationBadgeState {
  // Unread DM/Group показываются аватарами в ServerRail (PeopleRailSection),
  // на Home остаётся только счётчик входящих заявок в друзья.
  return selectFriendRequestNotificationBadge(state, currentUserId)
}

export function selectServerNotificationBadge(
  state: SyncState,
  serverId: string,
  _currentUserId?: string,
): NotificationBadgeState {
  const summaries = listServerChannels(state, serverId, _currentUserId).map(
    (channel) => channelNotificationSummary(state, channel),
  )
  const mentionCount = summaries.reduce(
    (count, summary) => count + summary.mentions,
    0,
  )

  if (mentionCount > 0) return badge(mentionCount, true)
  return badge(summaries.filter((summary) => summary.notifies).length)
}

export function selectChannelNotificationBadge(
  state: SyncState,
  channel: Channel,
): NotificationBadgeState {
  const summary = channelNotificationSummary(state, channel)
  if (summary.mentions > 0) return badge(summary.mentions, true)
  return summary.notifies ? badge(1) : EMPTY_NOTIFICATION_BADGE
}
