import type { Channel } from '@syrnike13/api-types'

import {
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
  const unreadChannels = listServerChannels(state, serverId, _currentUserId).filter(
    (channel) => isUnreadChannel(state, channel),
  ).length

  return badge(unreadChannels)
}

export function selectChannelNotificationBadge(
  state: SyncState,
  channel: Channel,
): NotificationBadgeState {
  return isUnreadChannel(state, channel) ? badge(1) : EMPTY_NOTIFICATION_BADGE
}
