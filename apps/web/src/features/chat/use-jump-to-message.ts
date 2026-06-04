import { useEffect, useRef } from 'react'
import { toast } from 'sonner'

import {
  fetchChannelMessage,
  fetchChannelMessages,
  MESSAGE_PAGE_SIZE,
} from '#/features/api/messages-api'
import { syncStore } from '#/features/sync/sync-store'

const HIGHLIGHT_CLASS = 'ring-2 ring-primary ring-offset-2 ring-offset-background'

export function useJumpToMessage(
  channelId: string,
  messageId: string | undefined,
  token: string | undefined,
) {
  const lastJumped = useRef<string | null>(null)

  useEffect(() => {
    if (!messageId || !token || lastJumped.current === messageId) return

    let cancelled = false

    async function jump() {
      const scrollTo = () => {
        const el = document.querySelector(
          `[data-message-id="${messageId}"]`,
        ) as HTMLElement | null
        if (!el) return false
        el.scrollIntoView({ block: 'center', behavior: 'smooth' })
        el.classList.add(HIGHLIGHT_CLASS)
        window.setTimeout(() => el.classList.remove(HIGHLIGHT_CLASS), 2500)
        return true
      }

      if (scrollTo()) {
        lastJumped.current = messageId!
        return
      }

      try {
        const message = await fetchChannelMessage(token!, channelId, messageId!)
        if (cancelled) return
        syncStore.upsertMessage(message)
        if (message.user) {
          syncStore.upsertUser(message.user)
        }

        const { messages: older, users } = await fetchChannelMessages(
          token!,
          channelId,
          { before: messageId!, limit: MESSAGE_PAGE_SIZE },
        )
        if (cancelled) return
        for (const user of users) {
          syncStore.upsertUser(user)
        }
        for (const item of older) {
          if (item.user) syncStore.upsertUser(item.user)
        }
        syncStore.prependChannelMessages(channelId, older)

        requestAnimationFrame(() => {
          if (!scrollTo()) {
            toast.error('Сообщение не найдено в ленте')
          } else {
            lastJumped.current = messageId!
          }
        })
      } catch (error) {
        if (!cancelled) {
          toast.error(
            error instanceof Error
              ? error.message
              : 'Не удалось открыть сообщение',
          )
        }
      }
    }

    void jump()

    return () => {
      cancelled = true
    }
  }, [channelId, messageId, token])
}
