import {
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
  type ReactNode,
  type Ref,
  type RefObject,
  type UIEvent,
} from 'react'
import type { Message, User } from '@syrnike13/api-types'
import { useTranslations } from '@syrnike13/ui/i18n'
import { ChevronDownIcon } from '#/components/icons'

import { MessageRow } from '#/components/chat/message-row'
import { Button } from '@syrnike13/ui/primitives/button'
import { MessageDivider } from '@syrnike13/ui/primitives/message'
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
import { useSyncStore } from '@syrnike13/client/sync/sync-store'
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
  /** На сколько пикселей поднять нижнюю границу overlay-скроллбара. */
  scrollbarInsetBottom?: number
  /** Подсветить сообщение без прокрутки (цель ответа в композере). */
  highlightMessageId?: string
  /** Прокрутить к сообщению и кратко подсветить его (deep link, цитата). */
  jumpMessageId?: string
  /** Начало истории канала: показывается над первым сообщением. */
  intro?: ReactNode
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

function ChatScrollbar({
  viewportRef,
  revision,
  trackInsetBottom,
}: {
  viewportRef: RefObject<HTMLDivElement | null>
  revision: number
  trackInsetBottom: number
}) {
  const [thumb, setThumb] = useState<{ top: number; height: number } | null>(
    null,
  )
  const [active, setActive] = useState(false)
  const hideTimer = useRef<number | null>(null)
  const drag = useRef<{
    startY: number
    startScrollTop: number
    ratio: number
  } | null>(null)

  const update = useCallback(() => {
    const viewport = viewportRef.current
    if (!viewport) return

    const { clientHeight, scrollHeight, scrollTop } = viewport
    const trackHeight = Math.max(0, clientHeight - trackInsetBottom)
    if (scrollHeight <= clientHeight + 1 || trackHeight <= 0) {
      setThumb(null)
      return
    }

    const height = Math.min(
      trackHeight,
      Math.max(24, (clientHeight / scrollHeight) * trackHeight),
    )
    const maxTop = Math.max(0, trackHeight - height)
    const offset = scrollHeight - clientHeight

    setThumb({
      top: offset > 0 ? (scrollTop / offset) * maxTop : 0,
      height,
    })
  }, [trackInsetBottom, viewportRef])

  const show = useCallback(() => {
    setActive(true)
    if (hideTimer.current !== null) window.clearTimeout(hideTimer.current)
    hideTimer.current = window.setTimeout(() => setActive(false), 900)
  }, [])

  useEffect(() => {
    update()
  }, [revision, update])

  useEffect(() => {
    const viewport = viewportRef.current
    if (!viewport) return

    const onScroll = () => {
      update()
      show()
    }

    viewport.addEventListener('scroll', onScroll, { passive: true })
    const observer =
      typeof ResizeObserver === 'undefined'
        ? null
        : new ResizeObserver(() => update())
    observer?.observe(viewport)
    const content = viewport.firstElementChild
    if (content) observer?.observe(content)

    return () => {
      viewport.removeEventListener('scroll', onScroll)
      observer?.disconnect()
      if (hideTimer.current !== null) {
        window.clearTimeout(hideTimer.current)
        hideTimer.current = null
      }
    }
  }, [show, update, viewportRef])

  if (!thumb) return null

  return (
    <div
      className={cn(
        'pointer-events-none absolute top-0 right-0 bottom-(--chat-scrollbar-inset) z-10 w-2 opacity-0 transition-opacity duration-150 group-hover/message-scroller:opacity-100',
        active && 'opacity-100',
      )}
      style={
        {
          '--chat-scrollbar-inset': `${trackInsetBottom}px`,
        } as CSSVars
      }
      aria-hidden="true"
    >
      {/* eslint-disable-next-line design/no-lookalike -- drag thumb of the custom chat scrollbar */}
      <div
        className="pointer-events-auto absolute right-0.5 top-(--chat-scroll-thumb-top) h-(--chat-scroll-thumb-height) w-1 cursor-grab rounded-full bg-foreground/25 transition-colors hover:bg-foreground/40 active:cursor-grabbing"
        style={
          {
            '--chat-scroll-thumb-top': `${thumb.top}px`,
            '--chat-scroll-thumb-height': `${thumb.height}px`,
          } as CSSVars
        }
        onPointerDown={(event) => {
          const viewport = viewportRef.current
          if (!viewport) return

          event.preventDefault()
          event.currentTarget.setPointerCapture(event.pointerId)
          drag.current = {
            startY: event.clientY,
            startScrollTop: viewport.scrollTop,
            ratio:
              (viewport.scrollHeight - viewport.clientHeight) /
              Math.max(
                1,
                viewport.clientHeight - trackInsetBottom - thumb.height,
              ),
          }
          show()
        }}
        onPointerMove={(event) => {
          const state = drag.current
          const viewport = viewportRef.current
          if (!state || !viewport) return

          viewport.scrollTop =
            state.startScrollTop +
            (event.clientY - state.startY) * state.ratio
        }}
        onPointerUp={(event) => {
          drag.current = null
          if (event.currentTarget.hasPointerCapture(event.pointerId)) {
            event.currentTarget.releasePointerCapture(event.pointerId)
          }
        }}
        onPointerCancel={() => {
          drag.current = null
        }}
      />
    </div>
  )
}

function MessageListBody({
  ref,
  channelId,
  serverId,
  scrollPaddingBottom,
  scrollbarInsetBottom = 0,
  highlightMessageId,
  jumpMessageId,
  intro,
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

  const [flashMessageId, setFlashMessageId] = useState<string | null>(null)
  const jumpedRef = useRef<string | null>(null)

  useEffect(() => {
    if (jumpMessageId == null) {
      jumpedRef.current = null
      return
    }
    if (jumpedRef.current === jumpMessageId) return

    let frame = 0
    let attempts = 0

    const run = () => {
      if (
        scroller.scrollToMessage(jumpMessageId, {
          align: 'center',
          behavior: 'smooth',
        })
      ) {
        jumpedRef.current = jumpMessageId
        setFlashMessageId(jumpMessageId)
        return
      }
      attempts += 1
      if (attempts < 30) {
        frame = requestAnimationFrame(run)
      }
    }

    run()
    return () => cancelAnimationFrame(frame)
  }, [jumpMessageId, messages.length, scroller])

  useEffect(() => {
    if (flashMessageId == null) return
    const timer = window.setTimeout(() => setFlashMessageId(null), 2000)
    return () => window.clearTimeout(timer)
  }, [flashMessageId])

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

  return (
    <TooltipProvider delay={300}>
      <MessageScroller className="min-h-0 flex-1" style={scrollVars}>
        {/* eslint-disable-next-line design/no-restyle -- the feed hides the native scrollbar and draws its own overlay one */}
        <MessageScrollerViewport
          ref={viewportRef}
          aria-label={t('messagesLabel')}
          className="chat-feed-scroll"
          onScroll={handleScroll}
        >
          <MessageScrollerContent className="pt-4 pb-(--scroll-padding)">
            {intro && !hasOlder ? (
              <MessageScrollerItem className="min-w-0">{intro}</MessageScrollerItem>
            ) : null}
            {feedItems.map((item) => {
              if (item.type === 'date') {
                return (
                  <MessageScrollerItem key={item.key} className="min-w-0">
                    <MessageDivider aria-label={item.dateLabel}>
                      {item.dateLabel}
                    </MessageDivider>
                  </MessageScrollerItem>
                )
              }

              if (item.type === 'unread') {
                return (
                  <MessageScrollerItem key={item.key} className="min-w-0">
                    <MessageDivider variant="unread" aria-label={t('newMessages')}>
                      {t('newMessagesShort')}
                    </MessageDivider>
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
                      item.message._id === highlightMessageId ||
                      item.message._id === flashMessageId
                    }
                    {...rowProps}
                  />
                </MessageScrollerItem>
              )
            })}
          </MessageScrollerContent>
        </MessageScrollerViewport>

        <ChatScrollbar
          viewportRef={viewportRef}
          revision={messages.length}
          trackInsetBottom={scrollbarInsetBottom}
        />

        {loadingOlder ? (
          <div className="pointer-events-none absolute inset-x-0 top-2 z-10 flex justify-center">
            <Spinner className="size-5 text-muted-foreground" />
          </div>
        ) : null}

        <MessageJumpButton />
      </MessageScroller>
    </TooltipProvider>
  )
}

/**
 * Кнопка подписана на scrollable-состояние сама. Иначе каждое появление
 * кнопки перерендеривало бы всю ленту (сотни строк и embed-карточек).
 */
function MessageJumpButton() {
  const t = useTranslations('chat')
  const { end } = useMessageScrollerScrollable()
  const scroller = useMessageScroller()

  return (
    <div
      className={cn(
        'absolute bottom-(--jump-offset) left-1/2 z-10 -translate-x-1/2 transition-all duration-200',
        end
          ? 'pointer-events-auto translate-y-0 opacity-100'
          : 'pointer-events-none translate-y-2 opacity-0',
      )}
      aria-hidden={!end}
    >
      <Button
        type="button"
        variant="secondary"
        size="sm"
        shape="circle"
        tabIndex={end ? 0 : -1}
        onClick={() => scroller.scrollToEnd({ behavior: 'smooth' })}
      >
        <ChevronDownIcon />
        {t('jumpToPresent')}
      </Button>
    </div>
  )
}
