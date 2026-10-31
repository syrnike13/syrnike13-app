import { useEffect } from 'react'
import type { Message } from '@syrnike13/api-types'
import { useTranslations, type Translator } from '@syrnike13/ui/i18n'

import { useAuth } from '#/features/auth/auth-context'
import { eventsGateway } from '#/features/events/gateway'
import { getChannelLabel } from '@syrnike13/client/sync/channel-label'
import { syncStore } from '@syrnike13/client/sync/sync-store'

function canNotify() {
  return (
    typeof window !== 'undefined' &&
    'Notification' in window &&
    Notification.permission === 'granted'
  )
}

function notificationTitle(
  message: Message,
  currentUserId: string | undefined,
  t: Translator,
  tChat: Translator,
) {
  const state = syncStore.getState()
  const channel = state.channels[message.channel]
  if (!channel) return t('newMessage')

  const author =
    message.user ??
    state.users[message.author] ??
    ({ username: t('someone') } as const)

  const channelName = getChannelLabel(
    channel,
    state.users,
    currentUserId,
    tChat,
  )
  return `${author.display_name ?? author.username} · ${channelName}`
}

function activeChannelIdFromPath() {
  const match = window.location.pathname.match(/\/c\/([^/]+)/)
  return match?.[1] ?? null
}

export function useMessageNotifications() {
  const t = useTranslations('notifications')
  const tChat = useTranslations('chat')
  const auth = useAuth()

  useEffect(() => {
    const unsubscribe = eventsGateway.subscribeServerEvents((event) => {
      if (event.type !== 'Message') return

      const message: Message = event
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
        (message.attachments?.length ? t('attachment') : t('message'))

      const notification = new Notification(
        notificationTitle(message, auth.user?._id, t, tChat),
        { body, tag: message._id },
      )

      notification.onclick = () => {
        window.focus()
        window.location.href = `/c/${message.channel}`
        notification.close()
      }
    })
    return () => {
      unsubscribe()
    }
  }, [auth.user?._id, t, tChat])
}
