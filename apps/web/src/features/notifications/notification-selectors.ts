import type { Channel } from '@syrnike13/api-types'

import { isDmChannel, isTextChannel } from '#/features/sync/channel-label'
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

function isUnreadChannel(state: SyncState, channel: Channel) {
  return isChannelUnread(channel, state.unreads[channel._id])
}

function hasChannelNotification(state: SyncState, channel: Channel) {
  const unread = state.unreads[channel._id]
  return (
    isChannelUnread(channel, unread) ||
    channelUnreadMentionCount(unread) > 0
  )
}

function countPersonalChannelNotifications(state: SyncState) {
  return Object.values(state.channels).reduce(
    (summary, channel) => {
      if (!isDmChannel(channel) || !isTextChannel(channel)) return summary

      const unread = state.unreads[channel._id]
      const mentionCount = channelUnreadMentionCount(unread)
      if (mentionCount > 0) {
        return {
          count: summary.count + mentionCount,
          urgent: true,
        }
      }

      if (!isChannelUnread(channel, unread)) return summary

      return {
        count: summary.count + 1,
        urgent: summary.urgent,
      }
    },
    { count: 0, urgent: false },
  )
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
  const incomingFriendRequests = selectFriendRequestNotificationBadge(
    state,
    currentUserId,
  ).count
  const personalChannels = countPersonalChannelNotifications(state)

  return badge(
    incomingFriendRequests + personalChannels.count,
    personalChannels.urgent,
  )
}

export function selectServerNotificationBadge(
  state: SyncState,
  serverId: string,
  _currentUserId?: string,
): NotificationBadgeState {
  const notifiedChannels = listServerChannels(
    state,
    serverId,
    _currentUserId,
  ).filter((channel) => hasChannelNotification(state, channel))
  const mentionCount = notifiedChannels.reduce(
    (count, channel) =>
      count + channelUnreadMentionCount(state.unreads[channel._id]),
    0,
  )

  if (mentionCount > 0) return badge(mentionCount, true)
  return badge(notifiedChannels.length)
}

export function selectChannelNotificationBadge(
  state: SyncState,
  channel: Channel,
): NotificationBadgeState {
  const mentionCount = channelUnreadMentionCount(state.unreads[channel._id])
  if (mentionCount > 0) return badge(mentionCount, true)
  return isUnreadChannel(state, channel) ? badge(1) : EMPTY_NOTIFICATION_BADGE
}
