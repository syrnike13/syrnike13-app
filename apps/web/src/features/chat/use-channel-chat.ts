import { useQuery } from '@tanstack/react-query'
import { useNavigate } from '@tanstack/react-router'
import { useCallback, useEffect, useRef, useState } from 'react'
import type { Message } from '@syrnike13/api-types'
import { useTranslations } from '@syrnike13/ui/i18n'
import { Effect } from 'effect'

import { useAuth } from '#/features/auth/auth-context'
import {
  deleteChannelMessageEffect,
  fetchChannelMessagesEffect,
  MESSAGE_PAGE_SIZE,
  pinChannelMessageEffect,
  unpinChannelMessageEffect,
} from '@syrnike13/client/api/messages-api'
import { ackChannelEffect } from '@syrnike13/client/api/sync-api'
import { useJumpToMessage } from '#/features/chat/use-jump-to-message'
import { useTypingIndicator } from '#/features/chat/use-typing-indicator'
import { getChannelMessages } from '@syrnike13/client/sync/selectors'
import { syncStore, useSyncStore } from '@syrnike13/client/sync/sync-store'
import { queryKeys } from '#/lib/api/query-keys'
import { serverChannelServerId } from '@syrnike13/client/lib/channel-voice'

type ComposerAction =
  | { type: 'reply'; message: Message }
  | { type: 'edit'; message: Message }
  | null

type UseChannelChatOptions = {
  channelId: string
  highlightMessageId?: string
  enabled?: boolean
}

export function useChannelChat({
  channelId,
  highlightMessageId,
  enabled = true,
}: UseChannelChatOptions) {
  const t = useTranslations('chat')
  const auth = useAuth()
  const navigate = useNavigate()
  const { notifyTyping, stopTyping } = useTypingIndicator(channelId)
  const channel = useSyncStore((s) => s.channels[channelId])
  const users = useSyncStore((s) => s.users)
  const messages = useSyncStore((s) => getChannelMessages(s, channelId))
  const token = auth.session?.token

  useJumpToMessage(channelId, highlightMessageId, enabled ? token : undefined)

  const [composerAction, setComposerAction] = useState<ComposerAction>(null)
  const [hasOlder, setHasOlder] = useState(true)
  const [loadingOlder, setLoadingOlder] = useState(false)

  const historyQuery = useQuery({
    queryKey: queryKeys.channels.messages(channelId),
    queryFn: async ({ signal }) => {
      if (!token) return []
      const { messages: loaded, users: extraUsers } =
        await Effect.runPromise(
          fetchChannelMessagesEffect(token, channelId),
          { signal },
        )
      syncStore.setChannelMessages(channelId, loaded)
      syncStore.upsertUsers([
        ...extraUsers,
        ...loaded
          .map((message) => message.user)
          .filter((user): user is NonNullable<typeof user> => Boolean(user)),
      ])
      // Запрос мог завершиться после переключения на другой канал.
      if (activeChannelIdRef.current === channelId) {
        setHasOlder(loaded.length >= MESSAGE_PAGE_SIZE)
      }
      return loaded
    },
    enabled: enabled && !!token && !!channel,
    staleTime: 30_000,
  })

  const serverIdForSelection = serverChannelServerId(channel) ?? null

  const isServerChannel = serverIdForSelection != null

  const messagesRef = useRef(messages)
  messagesRef.current = messages
  const lastAckedMessageIdRef = useRef<string | null>(null)
  /** Канал, которому принадлежат async-завершения запросов (защита от гонок при смене канала). */
  const activeChannelIdRef = useRef(channelId)
  activeChannelIdRef.current = channelId
  const lastMessageId = messages.at(-1)?._id

  useEffect(() => {
    setComposerAction(null)
    setHasOlder(true)
    setLoadingOlder(false)
    lastAckedMessageIdRef.current = null
  }, [channelId])

  useEffect(() => {
    if (!enabled || !token || !lastMessageId || !channel) return
    if (lastAckedMessageIdRef.current === lastMessageId) return
    lastAckedMessageIdRef.current = lastMessageId

    syncStore.setChannelLastRead(channelId, lastMessageId)
    Effect.runFork(
      ackChannelEffect(token, channelId, lastMessageId).pipe(Effect.ignore),
    )
  }, [channel, channelId, enabled, lastMessageId, token])

  const loadOlder = useCallback(async () => {
    const currentMessages = messagesRef.current
    if (!enabled || !token || loadingOlder || currentMessages.length === 0) {
      return
    }

    const oldestId = currentMessages[0]?._id
    if (!oldestId) return

    const requestChannelId = channelId
    setLoadingOlder(true)
    await Effect.runPromise(
      fetchChannelMessagesEffect(token, requestChannelId, {
        before: oldestId,
      }).pipe(
        Effect.tap(({ messages: older, users: extraUsers }) =>
          Effect.sync(() => {
            syncStore.upsertUsers([
              ...extraUsers,
              ...older
                .map((message) => message.user)
                .filter((user): user is NonNullable<typeof user> =>
                  Boolean(user),
                ),
            ])

            syncStore.prependChannelMessages(requestChannelId, older)
            // Канал мог смениться, пока запрос был в полёте, — не трогаем чужое состояние.
            if (activeChannelIdRef.current === requestChannelId) {
              setHasOlder(older.length >= MESSAGE_PAGE_SIZE)
            }
          }),
        ),
        Effect.catch(() =>
          Effect.sync(() => {
            if (activeChannelIdRef.current === requestChannelId) {
            }
          }),
        ),
        Effect.ensuring(
          Effect.sync(() => {
            if (activeChannelIdRef.current === requestChannelId) {
              setLoadingOlder(false)
            }
          }),
        ),
      ),
    )
  }, [channelId, enabled, loadingOlder, t, token])

  const handleDelete = useCallback(
    async (message: Message) => {
      if (!token) return

      syncStore.removeMessage(channelId, message._id)
      await Effect.runPromise(
        deleteChannelMessageEffect(token, channelId, message._id).pipe(
          Effect.tap(() =>
            Effect.sync(() => {
              if (
                composerAction?.type === 'edit' &&
                composerAction.message._id === message._id
              ) {
                setComposerAction(null)
              }
            }),
          ),
          Effect.catch(() =>
            Effect.sync(() => {
              syncStore.upsertMessage(message)
            }),
          ),
        ),
      )
    },
    [channelId, composerAction, t, token],
  )

  const handlePin = useCallback(
    async (message: Message) => {
      if (!token) return
      syncStore.patchMessage(channelId, message._id, { pinned: true })
      await Effect.runPromise(
        pinChannelMessageEffect(token, channelId, message._id).pipe(
          Effect.tap(() =>
            Effect.sync(() => {}),
          ),
          Effect.catch(() =>
            Effect.sync(() => {
              syncStore.patchMessage(channelId, message._id, {
                pinned: message.pinned,
              })
            }),
          ),
        ),
      )
    },
    [channelId, t, token],
  )

  const jumpToMessage = useCallback(
    (messageId: string) => {
      void navigate({
        to: '/c/$channelId',
        params: { channelId },
        search: { m: messageId },
        replace: true,
      })
    },
    [channelId, navigate],
  )

  const handleUnpin = useCallback(
    async (message: Message) => {
      if (!token) return
      syncStore.patchMessage(channelId, message._id, { pinned: false })
      await Effect.runPromise(
        unpinChannelMessageEffect(token, channelId, message._id).pipe(
          Effect.tap(() =>
            Effect.sync(() => {}),
          ),
          Effect.catch(() =>
            Effect.sync(() => {
              syncStore.patchMessage(channelId, message._id, {
                pinned: message.pinned,
              })
            }),
          ),
        ),
      )
    },
    [channelId, t, token],
  )

  /** Discord: стрелка вверх в пустом композере редактирует своё последнее сообщение. */
  const editLastOwnMessage = useCallback(() => {
    const userId = auth.user?._id
    const last = [...messagesRef.current]
      .reverse()
      .find((message) => message.author === userId && !message.system)
    if (!last) return false
    setComposerAction({ type: 'edit', message: last })
    return true
  }, [auth.user?._id])

  const replyTo =
    composerAction?.type === 'reply' ? composerAction.message : null
  const editingMessage =
    composerAction?.type === 'edit' ? composerAction.message : null

  return {
    auth,
    channel,
    users,
    messages,
    token,
    historyQuery,
    serverIdForSelection,
    isServerChannel,
    composerAction,
    setComposerAction,
    hasOlder,
    loadingOlder,
    loadOlder,
    handleDelete,
    handlePin,
    handleUnpin,
    jumpToMessage,
    replyTo,
    editingMessage,
    jumpMessageId: highlightMessageId,
    editLastOwnMessage,
    notifyTyping,
    stopTyping,
  }
}
