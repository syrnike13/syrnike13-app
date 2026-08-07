import { useEffect, useRef } from 'react'
import { toast } from 'sonner'
import { Effect, Fiber } from 'effect'

import {
  fetchChannelMessageEffect,
  fetchChannelMessagesEffect,
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

    const scrollTo = () => {
      const element = document.querySelector<HTMLElement>(
        `[data-message-id="${messageId}"]`,
      )
      if (!element) return false
      element.scrollIntoView({ block: 'center', behavior: 'smooth' })
      element.classList.add(HIGHLIGHT_CLASS)
      window.setTimeout(() => element.classList.remove(HIGHLIGHT_CLASS), 2500)
      return true
    }

    const nextAnimationFrame = Effect.callback<void>((resume) => {
      const frame = requestAnimationFrame(() => resume(Effect.void))
      return Effect.sync(() => cancelAnimationFrame(frame))
    })

    const fiber = Effect.runFork(
      Effect.gen(function*() {
        if (scrollTo()) {
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
          if (!scrollTo()) {
            toast.error('Сообщение не найдено в ленте')
          } else {
            lastJumped.current = messageId
          }
        })
      }).pipe(
        Effect.catch((error) =>
          Effect.sync(() => {
            toast.error(
              error instanceof Error
                ? error.message
                : 'Не удалось открыть сообщение',
            )
          }),
        ),
      ),
    )

    return () => {
      Effect.runFork(Fiber.interrupt(fiber))
    }
  }, [channelId, messageId, token])
}
