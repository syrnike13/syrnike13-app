import { useEffect, useRef } from 'react'
import { useTranslations } from '@syrnike13/ui/i18n'
import { Effect, Fiber } from 'effect'

import {
  fetchChannelMessageEffect,
  fetchChannelMessagesEffect,
  MESSAGE_PAGE_SIZE,
} from '#/features/api/messages-api'
import { syncStore } from '#/features/sync/sync-store'

export function useJumpToMessage(
  channelId: string,
  messageId: string | undefined,
  token: string | undefined,
) {
  const t = useTranslations('chat')
  const lastJumped = useRef<string | null>(null)

  useEffect(() => {
    if (!messageId || !token || lastJumped.current === messageId) return

    // Прокрутку и подсветку делает MessageList; здесь только догружаем
    // сообщение и историю перед ним, если их ещё нет в ленте.
    const isRendered = () =>
      document.querySelector(`[data-message-id="${messageId}"]`) != null

    const nextAnimationFrame = Effect.callback<void>((resume) => {
      const frame = requestAnimationFrame(() => resume(Effect.void))
      return Effect.sync(() => cancelAnimationFrame(frame))
    })

    const fiber = Effect.runFork(
      Effect.gen(function*() {
        if (isRendered()) {
          lastJumped.current = messageId
          return
        }

        const message = yield* fetchChannelMessageEffect(
          token,
          channelId,
          messageId,
        )
        yield* Effect.sync(() => {
          syncStore.upsertMessage(message)
          if (message.user) {
            syncStore.upsertUser(message.user)
          }
        })

        const { messages: older, users } = yield* fetchChannelMessagesEffect(
          token,
          channelId,
          {
            before: messageId,
            limit: MESSAGE_PAGE_SIZE,
          },
        )
        yield* Effect.sync(() => {
          for (const user of users) {
            syncStore.upsertUser(user)
          }
          for (const item of older) {
            if (item.user) syncStore.upsertUser(item.user)
          }
          syncStore.prependChannelMessages(channelId, older)
        })

        yield* nextAnimationFrame
        yield* Effect.sync(() => {
          if (!isRendered()) {
          } else {
            lastJumped.current = messageId
          }
        })
      }).pipe(
        Effect.catch(() =>
          Effect.sync(() => {
          }),
        ),
      ),
    )

    return () => {
      Effect.runFork(Fiber.interrupt(fiber))
    }
  }, [channelId, messageId, t, token])
}
