import type { Emoji, Member, Message, Server, User } from '@syrnike13/api-types'
import { PinIcon } from 'lucide-react'

import {
  MESSAGE_AVATAR_COLUMN,
  MESSAGE_COMPACT_CONTENT_INSET,
  MESSAGE_COMPACT_TIME_CLASS,
  MESSAGE_ROW_PADDING_X,
} from '#/components/chat/message-layout'
import { InlineReplyQuote } from '#/components/chat/message-reply-preview'
import { MessageHoverToolbar } from '#/components/chat/message-hover-toolbar'
import { MessageAttachments } from '#/components/chat/message-attachments'
import { MessageReactions } from '#/components/chat/message-reactions'
import { UserAvatar } from '#/components/user/user-avatar'
import { UserProfilePopover } from '#/components/user/user-profile-popover'
import { memberRoleEntries } from '#/features/sync/selectors'
import { useSyncStore } from '#/features/sync/sync-store'
import { renderMessageContent } from '#/lib/message-markdown'
import {
  formatMessageTimeShort,
  formatMessageTimestamp,
  messageCreatedAt,
} from '#/lib/message-time'
import { cn } from '#/lib/utils'

export type MessageRowProps = {
  message: Message
  channelId: string
  users: Record<string, User>
  emojis: Record<string, Emoji>
  messagesById: Record<string, Message>
  currentUserId?: string
  serverId?: string
  /** Продолжение группы от того же автора — без аватара и заголовка. */
  compact?: boolean
  /** Подсветка (ответ в композере, переход по ссылке). */
  highlighted?: boolean
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
  ) => void
}

function authorLabel(message: Message, users: Record<string, User>) {
  if (message.user) {
    return message.user.display_name ?? message.user.username
  }
  const user = users[message.author]
  return user?.display_name ?? user?.username ?? 'Неизвестный'
}

function memberDisplayColor(
  server: Server | undefined,
  member: Member | undefined,
): string | undefined {
  if (!server || !member) return undefined

  for (const role of memberRoleEntries(server, member)) {
    if (!role.colour) continue
    const colour = role.colour.trim()
    return colour.startsWith('#') ? colour : `#${colour}`
  }
  return undefined
}

export function MessageRow({
  message,
  channelId,
  users,
  emojis,
  messagesById,
  currentUserId,
  serverId,
  compact = false,
  highlighted = false,
  onJumpToMessage,
  onReply,
  onEdit,
  onDelete,
  onBlock,
  onPin,
  onUnpin,
  onToggleReaction,
}: MessageRowProps) {
  const server = useSyncStore((s) =>
    serverId ? s.servers[serverId] : undefined,
  )
  const member = useSyncStore((s) =>
    serverId ? s.members[`${serverId}:${message.author}`] : undefined,
  )

  const name = authorLabel(message, users)
  const authorUser = message.user ?? users[message.author]
  const own = message.author === currentUserId
  const hasContent = Boolean(message.content?.trim())
  const hasAttachments = Boolean(message.attachments?.length)
  const replyId = message.replies?.[0]
  const showReplyQuote = Boolean(replyId && !compact)
  const edited = Boolean(
    (message as Message & { edited?: string | null }).edited,
  )
  const createdAt = messageCreatedAt(message)
  const timestamp = formatMessageTimestamp(createdAt)
  const nameColor = memberDisplayColor(server, member)

  return (
    <article
      data-message-id={message._id}
      className={cn(
        'group relative -mx-4 flex items-start hover:bg-muted/40',
        compact
          ? cn('min-h-[1.375rem] py-0.5', MESSAGE_COMPACT_CONTENT_INSET)
          : cn('mt-[17px] gap-4 py-0.5', MESSAGE_ROW_PADDING_X),
        highlighted && 'bg-primary/10 hover:bg-primary/15',
      )}
    >
      {compact ? (
        <time
          dateTime={formatMessageTimestamp(createdAt)}
          className={MESSAGE_COMPACT_TIME_CLASS}
        >
          {formatMessageTimeShort(createdAt)}
        </time>
      ) : null}

      {!compact ? (
      <div
        className={cn(
          MESSAGE_AVATAR_COLUMN,
          showReplyQuote && 'mt-5',
        )}
      >
        {authorUser ? (
          <div>
            <UserProfilePopover
              user={authorUser}
              serverId={serverId}
              side="right"
              align="start"
              hideMessage={authorUser._id === currentUserId}
            >
              <button
                type="button"
                className="rounded-full focus-visible:ring-2 focus-visible:ring-ring"
              >
                <UserAvatar
                  user={authorUser}
                  className="size-10"
                  fallbackClassName="size-10"
                  showPresence={false}
                />
              </button>
            </UserProfilePopover>
          </div>
        ) : (
          <UserAvatar
            user={authorUser}
            className="size-10"
            fallbackClassName="size-10"
            showPresence={false}
          />
        )}
      </div>
      ) : null}

      <div className="relative min-w-0 flex-1">
        {showReplyQuote && replyId ? (
          <InlineReplyQuote
            replyId={replyId}
            messagesById={messagesById}
            users={users}
            serverId={serverId}
            onJump={onJumpToMessage}
          />
        ) : null}

        {!compact ? (
          <header className="mb-0.5 flex min-h-5 items-baseline gap-2 leading-snug">
            <span
              className="truncate font-semibold"
              style={nameColor ? { color: nameColor } : undefined}
            >
              {name}
            </span>
            <time
              className="shrink-0 text-[11px] font-medium text-muted-foreground"
              dateTime={timestamp}
            >
              {timestamp}
            </time>
            {message.pinned ? (
              <PinIcon
                className="size-3 shrink-0 text-primary"
                aria-label="Закреплено"
              />
            ) : null}
            {edited ? (
              <span className="shrink-0 text-[10px] text-muted-foreground">
                (изменено)
              </span>
            ) : null}
          </header>
        ) : (
          <span className="sr-only">
            {name}, {timestamp}
          </span>
        )}

        {onReply && onToggleReaction ? (
          <MessageHoverToolbar
            message={message}
            channelId={channelId}
            own={own}
            compact={compact}
            currentUserId={currentUserId}
            onReply={() => onReply(message)}
            onEdit={onEdit ? () => onEdit(message) : undefined}
            onDelete={onDelete ? () => onDelete(message) : undefined}
            onBlock={onBlock && !own ? () => onBlock(message) : undefined}
            onPin={onPin ? () => onPin(message) : undefined}
            onUnpin={onUnpin ? () => onUnpin(message) : undefined}
            onToggleReaction={(emoji, active) =>
              onToggleReaction(message._id, emoji, active)
            }
          />
        ) : null}

        <div className="flex flex-col gap-1 text-[15px] leading-snug text-foreground">
          {hasContent ? (
            <div className="whitespace-pre-wrap break-words">
              {renderMessageContent(message.content!, users, emojis)}
            </div>
          ) : null}
          {hasAttachments ? (
            <MessageAttachments attachments={message.attachments!} />
          ) : null}
          {!hasContent && !hasAttachments ? (
            <p className="text-xs text-muted-foreground italic">
              [системное сообщение]
            </p>
          ) : null}
        </div>

        {onToggleReaction ? (
          <div className="mt-0.5">
            <MessageReactions
              message={message}
              users={users}
              currentUserId={currentUserId}
              onToggle={(emoji, active) =>
                onToggleReaction(message._id, emoji, active)
              }
            />
          </div>
        ) : null}
      </div>
    </article>
  )
}
