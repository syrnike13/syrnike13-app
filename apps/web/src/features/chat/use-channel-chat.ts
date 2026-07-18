import { useQuery } from '@tanstack/react-query'
import { useNavigate } from '@tanstack/react-router'
import { useCallback, useEffect, useRef, useState } from 'react'
import type { Channel, Message } from '@syrnike13/api-types'
import { toast } from 'sonner'

import { useAuth } from '#/features/auth/auth-context'
import {
  deleteChannelMessage,
  fetchChannelMessages,
  MESSAGE_PAGE_SIZE,
  pinChannelMessage,
  unpinChannelMessage,
} from '#/features/api/messages-api'
import { ackChannel } from '#/features/api/sync-api'
import { useJumpToMessage } from '#/features/chat/use-jump-to-message'
import { useAppRoutePrefix } from '#/features/navigation/route-prefix'
import { useTypingIndicator } from '#/features/chat/use-typing-indicator'
import { getChannelMessages } from '#/features/sync/selectors'
import { syncStore, useSyncStore } from '#/features/sync/sync-store'
import { queryKeys } from '#/lib/api/query-keys'
import { serverChannelServerId } from '#/lib/channel-voice'

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
  const auth = useAuth()
  const navigate = useNavigate()
  const prefix = useAppRoutePrefix()
  const { notifyTyping, stopTyping } = useTypingIndicator(channelId)
  const channel = useSyncStore((s) => s.channels[channelId])
  const users = useSyncStore((s) => s.users)
  const messages = useSyncStore((s) => getChannelMessages(s, channelId))
  const token = auth.session?.token

  useJumpToMessage(channelId, highlightMessageId, enabled ? token : undefined)

  const [composerAction, setComposerAction] = useState<ComposerAction>(null)
  const [hasOlder, setHasOlder] = useState(true)
  const [loadingOlder, setLoadingOlder] = useState(false)

  const replyTargetId =
    composerAction?.type === 'reply' ? composerAction.message._id : null

  const historyQuery = useQuery({
    queryKey: queryKeys.channels.messages(channelId),
    queryFn: async () => {
      if (!token) return []
      const { messages: loaded, users: extraUsers } =
        await fetchChannelMessages(token, channelId)
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
    if (!replyTargetId) return
    requestAnimationFrame(() => {
      document
        .querySelector(`[data-message-id="${replyTargetId}"]`)
        ?.scrollIntoView({ block: 'center', behavior: 'smooth' })
    })
  }, [replyTargetId])

  useEffect(() => {
    if (!enabled || !token || !lastMessageId || !channel) return
    if (lastAckedMessageIdRef.current === lastMessageId) return
    lastAckedMessageIdRef.current = lastMessageId

    syncStore.setChannelLastRead(channelId, lastMessageId)
    void ackChannel(token, channelId, lastMessageId).catch(() => {})
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
    try {
      const { messages: older, users: extraUsers } = await fetchChannelMessages(
        token,
        requestChannelId,
        { before: oldestId },
      )

      syncStore.upsertUsers([
        ...extraUsers,
        ...older
          .map((message) => message.user)
          .filter((user): user is NonNullable<typeof user> => Boolean(user)),
      ])

      syncStore.prependChannelMessages(requestChannelId, older)
      // Канал мог смениться, пока запрос был в полёте, — не трогаем чужое состояние.
      if (activeChannelIdRef.current === requestChannelId) {
        setHasOlder(older.length >= MESSAGE_PAGE_SIZE)
      }
    } catch (error) {
      if (activeChannelIdRef.current === requestChannelId) {
        toast.error(
          error instanceof Error
            ? error.message
            : 'Не удалось загрузить сообщения',
        )
      }
    } finally {
      if (activeChannelIdRef.current === requestChannelId) {
        setLoadingOlder(false)
      }
    }
  }, [channelId, enabled, loadingOlder, token])

  const handleDelete = useCallback(
    async (message: Message) => {
      if (!token) return
      if (!window.confirm('Удалить это сообщение?')) return

      syncStore.removeMessage(channelId, message._id)
      try {
        await deleteChannelMessage(token, channelId, message._id)
        if (
          composerAction?.type === 'edit' &&
          composerAction.message._id === message._id
        ) {
          setComposerAction(null)
        }
      } catch (error) {
        syncStore.upsertMessage(message)
        toast.error(
          error instanceof Error ? error.message : 'Не удалось удалить',
        )
      }
    },
    [channelId, composerAction, token],
  )

  const handlePin = useCallback(
    async (message: Message) => {
      if (!token) return
      syncStore.patchMessage(channelId, message._id, { pinned: true })
      try {
        await pinChannelMessage(token, channelId, message._id)
        toast.success('Сообщение закреплено')
      } catch (error) {
        syncStore.patchMessage(channelId, message._id, {
          pinned: message.pinned,
        })
        toast.error(
          error instanceof Error ? error.message : 'Не удалось закрепить',
        )
      }
    },
    [channelId, token],
  )

  const jumpToMessage = useCallback(
    (messageId: string) => {
      void navigate({
        to: `${prefix}/c/$channelId`,
        params: { channelId },
        search: { m: messageId },
        replace: true,
      })
    },
    [channelId, navigate, prefix],
  )

  const handleUnpin = useCallback(
    async (message: Message) => {
      if (!token) return
      syncStore.patchMessage(channelId, message._id, { pinned: false })
      try {
        await unpinChannelMessage(token, channelId, message._id)
        toast.success('Сообщение откреплено')
      } catch (error) {
        syncStore.patchMessage(channelId, message._id, {
          pinned: message.pinned,
        })
        toast.error(
          error instanceof Error ? error.message : 'Не удалось открепить',
        )
      }
    },
    [channelId, token],
  )

  const replyTo =
    composerAction?.type === 'reply' ? composerAction.message : null
  const editingMessage =
    composerAction?.type === 'edit' ? composerAction.message : null
  const listHighlightMessageId = replyTo?._id ?? highlightMessageId

  return {
    auth,
    channel: channel as Channel | undefined,
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
    listHighlightMessageId,
    notifyTyping,
    stopTyping,
  }
}
