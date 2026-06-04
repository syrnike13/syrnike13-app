import { useEffect } from 'react'
import type { Message } from '@syrnike13/api-types'

import { useAuth } from '#/features/auth/auth-context'
import { eventsGateway } from '#/features/events/gateway'
import { getChannelLabel } from '#/features/sync/channel-label'
import { syncStore } from '#/features/sync/sync-store'
import type { GatewayServerEvent } from '#/features/sync/types'

function canNotify() {
  return (
    typeof window !== 'undefined' &&
    'Notification' in window &&
    Notification.permission === 'granted'
  )
}

function notificationTitle(message: Message, currentUserId?: string) {
  const state = syncStore.getState()
  const channel = state.channels[message.channel]
  if (!channel) return 'Новое сообщение'

  const author =
    message.user ??
    state.users[message.author] ??
    ({ username: 'Кто-то' } as const)

  const channelName = getChannelLabel(channel, state.users, currentUserId)
  return `${author.display_name ?? author.username} · ${channelName}`
}

function activeChannelIdFromPath() {
  const match = window.location.pathname.match(/\/app\/c\/([^/]+)/)
  return match?.[1] ?? null
}

export function useMessageNotifications() {
  const auth = useAuth()

  useEffect(() => {
    return eventsGateway.subscribeEvents((event) => {
      const gatewayEvent = event as GatewayServerEvent
      if (gatewayEvent.type !== 'Message') return

      const message = gatewayEvent as Message
      if (message.author === auth.user?._id) return

      const author = syncStore.getState().users[message.author]
      if (author?.relationship === 'Blocked') return

      if (
        document.hasFocus() &&
        activeChannelIdFromPath() === message.channel
      ) {
        return
      }

      if (!canNotify()) return

      const body =
        message.content?.trim().slice(0, 140) ||
        (message.attachments?.length ? 'Вложение' : 'Сообщение')

      const notification = new Notification(
        notificationTitle(message, auth.user?._id),
        { body, tag: message._id },
      )

      notification.onclick = () => {
        window.focus()
        window.location.href = `/app/c/${message.channel}`
        notification.close()
      }
    })
  }, [auth.user?._id])
}
