import {
  useEffect,
  useMemo,
  useRef,
  type ComponentProps,
  type RefObject,
} from 'react'
import type { Message, User } from '@syrnike13/api-types'
import { Loader2Icon } from 'lucide-react'
import {
  useVirtualizer,
  type Virtualizer,
} from '@tanstack/react-virtual'

import { MessageDateDivider } from '#/components/chat/message-date-divider'
import { MessageRow } from '#/components/chat/message-row'
import { useSyncStore } from '#/features/sync/sync-store'
import {
  buildMessageFeedItems,
  feedItemEstimateHeight,
  type MessageFeedItem,
} from '#/lib/message-feed'
import { cn } from '#/lib/utils'

const VIRTUAL_THRESHOLD = 60

type MessageListProps = {
  channelId: string
  serverId?: string
  /** Доп. отступ снизу, когда композер плавает над лентой */
  scrollPaddingClassName?: string
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

function feedIndexForMessage(
  feedItems: MessageFeedItem[],
  messageId: string,
): number {
  return feedItems.findIndex(
    (item) => item.type === 'message' && item.message._id === messageId,
  )
}

type MessageRowSharedProps = Omit<
  ComponentProps<typeof MessageRow>,
  'message' | 'compact' | 'highlighted'
>

function FeedListItem({
  item,
  rowProps,
  highlightMessageId,
}: {
  item: MessageFeedItem
  rowProps: MessageRowSharedProps
  highlightMessageId?: string
}) {
  if (item.type === 'date') {
    return <MessageDateDivider label={item.dateLabel} />
  }

  return (
    <MessageRow
      message={item.message}
      compact={item.compact}
      highlighted={
        highlightMessageId != null &&
        item.message._id === highlightMessageId
      }
      {...rowProps}
    />
  )
}

export function MessageList({
  channelId,
  serverId,
  scrollPaddingClassName,
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
}: MessageListProps) {
  const emojis = useSyncStore((s) => s.emojis)

  const scrollRef = useRef<HTMLDivElement>(null)
  const topSentinelRef = useRef<HTMLDivElement>(null)
  const bottomRef = useRef<HTMLDivElement>(null)
  const onLoadOlderRef = useRef(onLoadOlder)
  onLoadOlderRef.current = onLoadOlder
  const canLoadOlderRef = useRef(false)
  const lastMessageId = messages.at(-1)?._id
  const wasLoadingOlder = useRef(false)
  const scrollHeightBeforeLoad = useRef(0)
  const anchorMessageIdRef = useRef<string | null>(null)

  const feedItems = useMemo(() => buildMessageFeedItems(messages), [messages])
  const useVirtual = feedItems.length >= VIRTUAL_THRESHOLD

  const messagesById = useMemo(() => {
    const map: Record<string, Message> = {}
    for (const message of messages) {
      map[message._id] = message
    }
    return map
  }, [messages])

  const scrollToIndexRef = useRef<
    Virtualizer<HTMLDivElement, Element>['scrollToIndex']
  >(() => {})
  const feedItemsForScrollRef = useRef(feedItems)
  feedItemsForScrollRef.current = feedItems

  useEffect(() => {
    canLoadOlderRef.current = false
  }, [channelId])

  const rowProps: MessageRowSharedProps = {
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

  useEffect(() => {
    if (useVirtual) {
      if (!lastMessageId) return
      const index = feedIndexForMessage(
        feedItemsForScrollRef.current,
        lastMessageId,
      )
      if (index >= 0) {
        scrollToIndexRef.current(index, { align: 'end', behavior: 'auto' })
      }
    } else {
      bottomRef.current?.scrollIntoView({ behavior: 'auto' })
    }
    const timer = window.setTimeout(() => {
      canLoadOlderRef.current = true
    }, 0)
    return () => window.clearTimeout(timer)
  }, [channelId, lastMessageId, useVirtual, feedItems.length])

  useEffect(() => {
    if (loadingOlder) {
      wasLoadingOlder.current = true
      anchorMessageIdRef.current = messages[0]?._id ?? null
      if (!useVirtual) {
        scrollHeightBeforeLoad.current = scrollRef.current?.scrollHeight ?? 0
      }
      return
    }

    if (!wasLoadingOlder.current) return

    const items = feedItemsForScrollRef.current
    const anchorId = anchorMessageIdRef.current

    if (useVirtual && anchorId) {
      const index = feedIndexForMessage(items, anchorId)
      if (index >= 0) {
        scrollToIndexRef.current(index, { align: 'start' })
      }
    } else if (scrollRef.current) {
      const delta =
        scrollRef.current.scrollHeight - scrollHeightBeforeLoad.current
      scrollRef.current.scrollTop += delta
    }

    wasLoadingOlder.current = false
    anchorMessageIdRef.current = null
  }, [loadingOlder, useVirtual, messages])

  useEffect(() => {
    const root = scrollRef.current
    const sentinel = topSentinelRef.current
    if (!root || !sentinel || !hasOlder || !onLoadOlder) return

    const observer = new IntersectionObserver(
      (entries) => {
        const entry = entries[0]
        if (
          entry?.isIntersecting &&
          !loadingOlder &&
          canLoadOlderRef.current
        ) {
          onLoadOlderRef.current?.()
        }
      },
      { root, rootMargin: '120px 0px 0px 0px', threshold: 0 },
    )

    observer.observe(sentinel)
    return () => observer.disconnect()
  }, [channelId, hasOlder, loadingOlder])

  if (messages.length === 0) {
    return (
      <div
        className={cn(
          'flex h-0 min-h-0 flex-1 items-center justify-center overflow-hidden p-8 text-sm text-muted-foreground',
          scrollPaddingClassName,
        )}
      >
        Сообщений пока нет. Напишите первым.
      </div>
    )
  }

  return (
    <div
      ref={scrollRef}
      className="flex h-0 min-h-0 flex-1 flex-col overflow-y-auto overflow-x-hidden"
    >
      <div
        className={cn(
          'flex flex-col px-4 pt-4',
          scrollPaddingClassName,
        )}
      >
        <div ref={topSentinelRef} className="h-px shrink-0" aria-hidden />

        {loadingOlder ? (
          <div className="flex justify-center py-2">
            <Loader2Icon className="size-5 animate-spin text-muted-foreground" />
          </div>
        ) : null}

        {useVirtual ? (
          <VirtualizedFeedItems
            feedItems={feedItems}
            scrollRef={scrollRef}
            scrollToIndexRef={scrollToIndexRef}
            rowProps={rowProps}
            highlightMessageId={highlightMessageId}
          />
        ) : (
          <>
            {feedItems.map((item) => (
              <FeedListItem
                key={item.key}
                item={item}
                rowProps={rowProps}
                highlightMessageId={highlightMessageId}
              />
            ))}
            <div ref={bottomRef} className="h-px shrink-0" aria-hidden />
          </>
        )}
      </div>
    </div>
  )
}

type VirtualizedFeedItemsProps = {
  feedItems: MessageFeedItem[]
  scrollRef: RefObject<HTMLDivElement | null>
  scrollToIndexRef: RefObject<
    Virtualizer<HTMLDivElement, Element>['scrollToIndex']
  >
  rowProps: MessageRowSharedProps
  highlightMessageId?: string
}

function VirtualizedFeedItems({
  feedItems,
  scrollRef,
  scrollToIndexRef,
  rowProps,
  highlightMessageId,
}: VirtualizedFeedItemsProps) {
  const virtualizer = useVirtualizer({
    count: feedItems.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: (index) => feedItemEstimateHeight(feedItems[index]!),
    overscan: 12,
    getItemKey: (index) => feedItems[index]!.key,
  })

  scrollToIndexRef.current = virtualizer.scrollToIndex

  const virtualItems = virtualizer.getVirtualItems()

  return (
    <div
      className="relative w-full"
      style={{ height: virtualizer.getTotalSize() }}
    >
      {virtualItems.map((virtualRow) => {
        const item = feedItems[virtualRow.index]
        if (!item) return null

        return (
          <div
            key={item.key}
            ref={virtualizer.measureElement}
            data-index={virtualRow.index}
            className="absolute top-0 left-0 w-full"
            style={{
              transform: `translateY(${virtualRow.start}px)`,
            }}
          >
            <FeedListItem
              item={item}
              rowProps={rowProps}
              highlightMessageId={highlightMessageId}
            />
          </div>
        )
      })}
    </div>
  )
}
