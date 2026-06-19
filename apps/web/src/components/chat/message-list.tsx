import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  type ComponentProps,
  type RefObject,
} from 'react'
import type { Message, User } from '@syrnike13/api-types'
import { Loader2Icon } from '#/components/icons'
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
/** Порог (px): считаем, что пользователь «внизу» ленты. */
const STICKY_BOTTOM_THRESHOLD_PX = 96

function isNearBottom(element: HTMLDivElement, threshold = STICKY_BOTTOM_THRESHOLD_PX) {
  return (
    element.scrollHeight - element.scrollTop - element.clientHeight <= threshold
  )
}

function isScrollable(element: HTMLDivElement) {
  return element.scrollHeight > element.clientHeight
}

function scrollContainerToBottom(
  element: HTMLDivElement,
  behavior: ScrollBehavior = 'auto',
) {
  const top = element.scrollHeight - element.clientHeight
  if (behavior === 'auto') {
    element.scrollTop = top
    return
  }
  element.scrollTo({ top, behavior })
}

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
  onClearReactions?: (message: Message) => void
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
  onClearReactions,
  onToggleReaction,
}: MessageListProps) {
  const emojis = useSyncStore((s) => s.emojis)

  const scrollRef = useRef<HTMLDivElement>(null)
  const topSentinelRef = useRef<HTMLDivElement>(null)
  const onLoadOlderRef = useRef(onLoadOlder)
  onLoadOlderRef.current = onLoadOlder
  const canLoadOlderRef = useRef(false)
  const stickToBottomRef = useRef(true)
  const prevLastMessageIdRef = useRef<string | undefined>(undefined)
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
    Virtualizer<HTMLDivElement, Element>['scrollToIndex'] | null
  >(null)
  const feedItemsForScrollRef = useRef(feedItems)
  feedItemsForScrollRef.current = feedItems

  const scrollToTail = (behavior: ScrollBehavior = 'auto') => {
    const root = scrollRef.current
    if (!root) return

    const scrollToIndex = scrollToIndexRef.current
    if (useVirtual && lastMessageId && scrollToIndex) {
      const index = feedIndexForMessage(
        feedItemsForScrollRef.current,
        lastMessageId,
      )
      if (index >= 0) {
        scrollToIndex(index, { align: 'end', behavior })
        return
      }
    }

    scrollContainerToBottom(root, behavior)
  }

  const scrollToTailRef = useRef(scrollToTail)
  scrollToTailRef.current = scrollToTail

  const handleVirtualizerReady = useCallback(() => {
    if (!stickToBottomRef.current) return
    scrollToTailRef.current('auto')
  }, [])

  useEffect(() => {
    canLoadOlderRef.current = false
    stickToBottomRef.current = true
    prevLastMessageIdRef.current = undefined
  }, [channelId])

  useEffect(() => {
    const root = scrollRef.current
    if (!root) return

    const onScroll = () => {
      const nearBottom = isNearBottom(root)
      stickToBottomRef.current = nearBottom
      if (!nearBottom) {
        canLoadOlderRef.current = true
      }
    }

    root.addEventListener('scroll', onScroll, { passive: true })
    return () => root.removeEventListener('scroll', onScroll)
  }, [channelId, messages.length])

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
    onClearReactions,
    onToggleReaction: onToggleReaction
      ? (messageId: string, emoji: string, active: boolean) => {
          void onToggleReaction(messageId, emoji, active)
        }
      : undefined,
  }

  useEffect(() => {
    if (!lastMessageId) return

    const prevLastMessageId = prevLastMessageIdRef.current
    prevLastMessageIdRef.current = lastMessageId

    const isInitialTail = prevLastMessageId === undefined
    const isNewTailMessage = prevLastMessageId !== lastMessageId

    if (!isInitialTail && !isNewTailMessage) return
    if (!stickToBottomRef.current && !isInitialTail) return
    if (wasLoadingOlder.current) return

    const run = () => scrollToTail('auto')
    run()
    const raf = requestAnimationFrame(run)

    return () => {
      cancelAnimationFrame(raf)
    }
  }, [channelId, lastMessageId, useVirtual])

  useEffect(() => {
    const root = scrollRef.current
    const content = root?.firstElementChild
    if (!root || !(content instanceof HTMLElement)) return

    const observer = new ResizeObserver(() => {
      if (!stickToBottomRef.current) return
      scrollToTail('auto')
    })

    observer.observe(content)
    return () => observer.disconnect()
  }, [channelId, lastMessageId, useVirtual])

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

    const scrollToIndex = scrollToIndexRef.current
    if (useVirtual && anchorId && scrollToIndex) {
      const index = feedIndexForMessage(items, anchorId)
      if (index >= 0) {
        scrollToIndex(index, { align: 'start' })
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
        const canFillViewport = !isScrollable(root)
        if (
          entry?.isIntersecting &&
          !loadingOlder &&
          (canLoadOlderRef.current || canFillViewport)
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
            onVirtualizerReady={handleVirtualizerReady}
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
            <div className="h-px shrink-0" aria-hidden />
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
    Virtualizer<HTMLDivElement, Element>['scrollToIndex'] | null
  >
  onVirtualizerReady?: () => void
  rowProps: MessageRowSharedProps
  highlightMessageId?: string
}

function VirtualizedFeedItems({
  feedItems,
  scrollRef,
  scrollToIndexRef,
  onVirtualizerReady,
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

  useEffect(() => {
    scrollToIndexRef.current = virtualizer.scrollToIndex
    return () => {
      scrollToIndexRef.current = null
    }
  }, [scrollToIndexRef, virtualizer])

  useEffect(() => {
    onVirtualizerReady?.()
    const raf = requestAnimationFrame(() => onVirtualizerReady?.())
    return () => cancelAnimationFrame(raf)
  }, [onVirtualizerReady, feedItems.length])

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
