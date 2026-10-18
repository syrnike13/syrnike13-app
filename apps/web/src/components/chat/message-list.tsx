import {
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  type Ref,
  type UIEvent,
} from 'react'
import type { Message, User } from '@syrnike13/api-types'
import { useTranslations } from '@syrnike13/ui/i18n'
import { ChevronDownIcon, MessageSquareIcon } from '#/components/icons'

import { MessageDateDivider } from '#/components/chat/message-date-divider'
import { MessageRow } from '#/components/chat/message-row'
import { MessageUnreadDivider } from '#/components/chat/message-unread-divider'
import { Button } from '@syrnike13/ui/primitives/button'
import { Empty, EmptyDescription, EmptyMedia, EmptyTitle } from '@syrnike13/ui/primitives/empty'
import {
  MessageScroller,
  MessageScrollerContent,
  MessageScrollerItem,
  MessageScrollerProvider,
  MessageScrollerViewport,
  useMessageScroller,
  useMessageScrollerScrollable,
} from '@syrnike13/ui/primitives/message-scroller'
import { Spinner } from '@syrnike13/ui/primitives/spinner'
import { TooltipProvider } from '@syrnike13/ui/primitives/tooltip'
import { useSyncStore } from '#/features/sync/sync-store'
import type { CSSVars } from '#/lib/css-vars'
import { buildMessageFeedItems } from '#/lib/message-feed'
import { useDateDividerLabel } from '#/lib/use-message-time'
import { cn } from '#/lib/utils'

/** Порог (px): считаем, что пользователь у верхней границы загруженной истории. */
const LOAD_OLDER_THRESHOLD_PX = 120

export type MessageListHandle = {
  scrollToEnd: (behavior?: ScrollBehavior) => void
}

type MessageListProps = {
  channelId: string
  serverId?: string
  ref?: Ref<MessageListHandle>
  /** Доп. отступ снизу, когда композер плавает над лентой */
  scrollPaddingBottom?: number
  /** Подсветить сообщение в ленте (ответ, deep link). */
  highlightMessageId?: string
  messages: Message[]
  users: Record<string, User>
  currentUserId?: string
  loadingOlder?: boolean
  hasOlder?: boolean
  onLoadOlder?: () => void
  onJumpToMessage?: (messageId: string) => void
  onReply?: (message: Message) => void
  onEdit?: (message: Message) => void
  onDelete?: (message: Message) => void
  onBlock?: (message: Message) => void
  onPin?: (message: Message) => void
  onUnpin?: (message: Message) => void
  onToggleReaction?: (
    messageId: string,
    emoji: string,
    active: boolean,
  ) => Promise<void>
}

export function MessageList({ ref, channelId, ...props }: MessageListProps) {
  const lastRead = useSyncStore(
    (s) => s.unreads[channelId]?.lastId ?? null,
  )
  // Значение фиксируется на монтировании канала до ack. Если unreads
  // приезжают чуть позже, добираем первое непустое значение.
  const initialLastReadRef = useRef<{
    channelId: string
    lastId: string | null
  }>({ channelId, lastId: lastRead })

  if (initialLastReadRef.current.channelId !== channelId) {
    initialLastReadRef.current = { channelId, lastId: lastRead }
  } else if (initialLastReadRef.current.lastId === null && lastRead !== null) {
    initialLastReadRef.current.lastId = lastRead
  }

  const unreadAnchorId = useMemo(() => {
    const lastReadId = initialLastReadRef.current.lastId
    if (!lastReadId) return null
    return props.messages.find((message) => message._id > lastReadId)?._id ?? null
  }, [channelId, lastRead, props.messages])

  return (
    <MessageScrollerProvider
      key={channelId}
      autoScroll
      defaultScrollPosition={unreadAnchorId ? 'last-anchor' : 'end'}
    >
      <MessageListBody
        {...props}
        ref={ref}
        channelId={channelId}
        unreadAnchorId={unreadAnchorId}
      />
    </MessageScrollerProvider>
  )
}

type MessageListBodyProps = MessageListProps & {
  channelId: string
  unreadAnchorId: string | null
}

function MessageListBody({
  ref,
  channelId,
  serverId,
  scrollPaddingBottom,
  highlightMessageId,
  messages,
  users,
  currentUserId,
  loadingOlder,
  hasOlder,
  onLoadOlder,
  onJumpToMessage,
  onReply,
  onEdit,
  onDelete,
  onBlock,
  onPin,
  onUnpin,
  onToggleReaction,
  unreadAnchorId,
}: MessageListBodyProps) {
  const t = useTranslations('chat')
  const formatDateLabel = useDateDividerLabel()
  const scroller = useMessageScroller()
  const { end } = useMessageScrollerScrollable()
  const viewportRef = useRef<HTMLDivElement>(null)
  const loadGuardRef = useRef(false)

  const emojis = useSyncStore((s) => s.emojis)

  const feedItems = useMemo(
    () =>
      buildMessageFeedItems(messages, {
        unreadMessageId: unreadAnchorId,
        formatDateLabel,
      }),
    [formatDateLabel, messages, unreadAnchorId],
  )

  const messagesById = useMemo(() => {
    const map: Record<string, Message> = {}
    for (const message of messages) {
      map[message._id] = message
    }
    return map
  }, [messages])

  const jumpOffset =
    scrollPaddingBottom != null
      ? Math.max(16, scrollPaddingBottom - 24)
      : 16
  const scrollVars = {
    '--scroll-padding': `${scrollPaddingBottom ?? 0}px`,
    '--jump-offset': `${jumpOffset}px`,
  } as CSSVars

  useImperativeHandle(
    ref,
    () => ({
      scrollToEnd: (behavior: ScrollBehavior = 'smooth') => {
        scroller.scrollToEnd({ behavior })
      },
    }),
    [scroller],
  )

  useEffect(() => {
    if (highlightMessageId == null) return

    let frame = 0
    let attempts = 0

    const run = () => {
      if (
        scroller.scrollToMessage(highlightMessageId, {
          align: 'center',
          behavior: 'smooth',
        })
      ) {
        return
      }
      attempts += 1
      if (attempts < 30) {
        frame = requestAnimationFrame(run)
      }
    }

    run()
    return () => cancelAnimationFrame(frame)
  }, [highlightMessageId, messages.length, scroller])

  const loadOlderIfNeeded = useCallback(() => {
    if (loadGuardRef.current || loadingOlder || !hasOlder || messages.length === 0) {
      return
    }
    loadGuardRef.current = true
    onLoadOlder?.()
  }, [hasOlder, loadingOlder, messages.length, onLoadOlder])

  useEffect(() => {
    if (!loadingOlder) loadGuardRef.current = false
  }, [loadingOlder])

  useEffect(() => {
    loadGuardRef.current = false
  }, [messages.length, hasOlder])

  const handleScroll = useCallback(
    (event: UIEvent<HTMLDivElement>) => {
      if (event.currentTarget.scrollTop < LOAD_OLDER_THRESHOLD_PX) {
        loadOlderIfNeeded()
      }
    },
    [loadOlderIfNeeded],
  )

  useEffect(() => {
    const viewport = viewportRef.current
    if (!viewport || viewport.clientHeight <= 0) return
    if (viewport.scrollHeight <= viewport.clientHeight + 1) {
      loadOlderIfNeeded()
    }
  }, [loadOlderIfNeeded, messages.length])

  const rowProps = {
    channelId,
    users,
    emojis,
    messagesById,
    currentUserId,
    serverId,
    onJumpToMessage,
    onReply,
    onEdit,
    onDelete,
    onBlock,
    onPin,
    onUnpin,
    onToggleReaction: onToggleReaction
      ? (messageId: string, emoji: string, active: boolean) => {
          void onToggleReaction(messageId, emoji, active)
        }
      : undefined,
  }

  if (messages.length === 0) {
    return (
      <div
        className="relative flex h-0 min-h-0 flex-1 flex-col"
        style={scrollVars}
      >
        <Empty className="h-full pb-(--scroll-padding)">
          <EmptyMedia variant="icon">
            <MessageSquareIcon />
          </EmptyMedia>
          <EmptyTitle>{t('noMessages')}</EmptyTitle>
          <EmptyDescription>{t('noMessagesHint')}</EmptyDescription>
        </Empty>
      </div>
    )
  }

  return (
    <TooltipProvider delay={300}>
      <MessageScroller className="min-h-0 flex-1" style={scrollVars}>
        <MessageScrollerViewport
          ref={viewportRef}
          aria-label={t('messagesLabel')}
          onScroll={handleScroll}
        >
          <MessageScrollerContent className="flex flex-col gap-0 pt-4 pb-(--scroll-padding)">
            {feedItems.map((item) => {
              if (item.type === 'date') {
                return (
                  <MessageScrollerItem key={item.key} className="min-w-0">
                    <MessageDateDivider label={item.dateLabel} />
                  </MessageScrollerItem>
                )
              }

              if (item.type === 'unread') {
                return (
                  <MessageScrollerItem key={item.key} className="min-w-0">
                    <MessageUnreadDivider label={t('newMessages')} />
                  </MessageScrollerItem>
                )
              }

              return (
                <MessageScrollerItem
                  key={item.key}
                  messageId={item.message._id}
                  scrollAnchor={item.message._id === unreadAnchorId}
                  className="min-w-0"
                >
                  <MessageRow
                    message={item.message}
                    compact={item.compact}
                    highlighted={
                      highlightMessageId != null &&
                      item.message._id === highlightMessageId
                    }
                    {...rowProps}
                  />
                </MessageScrollerItem>
              )
            })}
          </MessageScrollerContent>
        </MessageScrollerViewport>

        {loadingOlder ? (
          <div className="pointer-events-none absolute inset-x-0 top-2 z-10 flex justify-center">
            <Spinner className="size-5 text-muted-foreground" />
          </div>
        ) : null}

        {end ? (
          <div className="absolute bottom-(--jump-offset) left-1/2 z-10 -translate-x-1/2 shadow-md rounded-full">
            <Button
              type="button"
              variant="secondary"
              size="sm"
              className={cn('gap-1 rounded-full px-3')}
              onClick={() => scroller.scrollToEnd({ behavior: 'smooth' })}
            >
              <ChevronDownIcon className="size-4" />
              {t('jumpToPresent')}
            </Button>
          </div>
        ) : null}
      </MessageScroller>
    </TooltipProvider>
  )
}
