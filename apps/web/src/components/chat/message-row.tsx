import type { Emoji, Member, Message, Server, User } from '@syrnike13/api-types'
import { useTranslations, type Translator } from '@syrnike13/ui/i18n'
import { PhoneFilledIcon, PhoneOffIcon, PinIcon, ReplyIcon } from '#/components/icons'
import { useMemo, type ReactElement } from 'react'

import {
  MESSAGE_AVATAR_COLUMN,
  MESSAGE_COMPACT_CONTENT_INSET,
  MESSAGE_COMPACT_TIME_CLASS,
  MESSAGE_ROW_PADDING_X,
} from '#/components/chat/message-layout'
import { InlineReplyQuote } from '#/components/chat/message-reply-preview'
import { MessageHoverToolbar } from '#/components/chat/message-hover-toolbar'
import { MessageAttachments } from '#/components/chat/message-attachments'
import { MessageEmbeds, visibleEmbeds } from '#/components/chat/message-embeds'
import { MessageReactions } from '#/components/chat/message-reactions'
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from '@syrnike13/ui/primitives/context-menu'
import { UserAvatar } from '#/components/user/user-avatar'
import { UserProfilePopover } from '#/components/user/user-profile-popover'
import {
  memberRoleEntries,
  type MemberRoleEntry,
} from '#/features/sync/selectors'
import { useSyncStore } from '#/features/sync/sync-store'
import { isMessageMentioningUser } from '#/lib/mentions'
import { renderMessageContent } from '#/lib/message-markdown'
import {
  formatMessageTimeShort,
  formatMessageTimestamp,
  messageCreatedAt,
} from '#/lib/message-time'
import type { CSSVars } from '#/lib/css-vars'
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

function authorLabel(
  message: Message,
  users: Record<string, User>,
  fallback: string,
) {
  if (message.user) {
    return message.user.display_name ?? message.user.username
  }
  const user = users[message.author]
  return user?.display_name ?? user?.username ?? fallback
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

function callParticipantName(
  userId: string,
  users: Record<string, User>,
  fallback: string,
) {
  const user = users[userId]
  return user?.display_name ?? user?.username ?? fallback
}

function formatCallDuration(
  startedAt: Date,
  finishedAt: string,
  t: Translator,
) {
  const finishedAtMs = new Date(finishedAt).getTime()
  if (!Number.isFinite(finishedAtMs)) return null

  const durationSeconds = Math.max(
    1,
    Math.round((finishedAtMs - startedAt.getTime()) / 1000),
  )

  if (durationSeconds < 60) {
    return t('durationSeconds', { count: durationSeconds })
  }

  const durationMinutes = Math.max(1, Math.round(durationSeconds / 60))
  if (durationMinutes < 60) {
    return t('durationMinutes', { count: durationMinutes })
  }

  const durationHours = Math.max(1, Math.round(durationMinutes / 60))
  return t('durationHours', { count: durationHours })
}

function isSuccessfulVoiceCall(
  system: Extract<Message['system'], { type: 'call_started' }>,
) {
  return (
    Boolean(system.finished_at) &&
    (system.ended_reason ?? 'completed') === 'completed'
  )
}

function VoiceCallSystemCard({
  message,
  users,
  serverId,
  currentUserId,
}: {
  message: Message
  users: Record<string, User>
  serverId?: string
  currentUserId?: string
}) {
  const t = useTranslations('chat.system')
  if (message.system?.type !== 'call_started') return null

  const server = useSyncStore((s) =>
    serverId ? s.servers[serverId] : undefined,
  )
  const callerId = message.system.by
  const callerUser = users[callerId]
  const member = useSyncStore((s) =>
    serverId ? s.members[`${serverId}:${callerId}`] : undefined,
  )
  const callerName = callParticipantName(callerId, users, t('user'))
  const callerRoles =
    server && member ? memberRoleEntries(server, member) : undefined
  const hideCallerMessage = callerUser?._id === currentUserId
  const startedAt = messageCreatedAt(message)
  const timestamp = formatMessageTimestamp(startedAt)
  const duration = message.system.finished_at
    ? formatCallDuration(startedAt, message.system.finished_at, t)
    : null
  const endedReason = message.system.ended_reason ?? 'completed'
  const endedStatus =
    endedReason === 'cancelled'
      ? t('callCancelled')
      : endedReason === 'missed'
        ? t('callMissed')
        : t('callEnded')
  const callInfo = message.system.finished_at
    ? `${t('callStarted')} · ${endedStatus}${duration ? ` · ${duration}` : ''}`
    : `${t('callStarted')} · ${t('callOngoing')}`
  const successfulCall = isSuccessfulVoiceCall(message.system)

  const callerNameButton = callerUser ? (
    <MessageAuthorProfileTrigger
      user={callerUser}
      serverId={serverId}
      serverName={server?.name}
      roles={callerRoles}
      hideMessage={hideCallerMessage}
    >
      <button
        type="button"
        className={cn(
          'max-w-full truncate rounded-sm font-semibold text-left',
          'hover:underline focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none',
        )}
      >
        {callerName}
      </button>
    </MessageAuthorProfileTrigger>
  ) : (
    <span className="truncate font-semibold">{callerName}</span>
  )

  return (
    <article
      data-message-id={message._id}
      className={cn(
        'group relative -mx-4 flex items-center hover:bg-muted/40',
        cn('mt-4.25 gap-4 py-0.5', MESSAGE_ROW_PADDING_X),
      )}
    >
      <div className={MESSAGE_AVATAR_COLUMN} aria-hidden>
        <div
          className={cn(
            'flex size-10 items-center justify-center',
            successfulCall ? 'text-chart-3' : 'text-muted-foreground',
          )}
          aria-label={
            successfulCall ? t('successfulCall') : t('failedCall')
          }
        >
          {successfulCall ? (
            <PhoneFilledIcon className="size-5" />
          ) : (
            <PhoneOffIcon className="size-5" />
          )}
        </div>
      </div>

      <div className="min-w-0 flex-1">
        <p className="flex min-w-0 flex-wrap items-baseline gap-x-2 text-base leading-snug">
          <span className="min-w-0">
            {callerNameButton}
            <span className="text-muted-foreground">{` ${callInfo}`}</span>
          </span>
          <time
            className="shrink-0 text-xs font-medium text-muted-foreground"
            dateTime={timestamp}
          >
            {timestamp}
          </time>
        </p>
      </div>
    </article>
  )
}

function MessageAuthorProfileTrigger({
  user,
  serverId,
  serverName,
  roles,
  hideMessage,
  children,
}: {
  user: User
  serverId?: string
  serverName?: string
  roles?: MemberRoleEntry[]
  hideMessage?: boolean
  children: ReactElement
}) {
  return (
    <UserProfilePopover
      user={user}
      serverId={serverId}
      serverName={serverName}
      roles={roles}
      side="right"
      align="start"
      hideMessage={hideMessage}
    >
      {children}
    </UserProfilePopover>
  )
}

function systemUserLabel(
  userId: string,
  users: Record<string, User>,
  fallback: string,
) {
  const user = users[userId]
  return user?.display_name ?? user?.username ?? fallback
}

function systemMessageText(
  system: NonNullable<Message['system']>,
  users: Record<string, User>,
  t: Translator,
) {
  const label = (userId: string) => systemUserLabel(userId, users, t('user'))

  switch (system.type) {
    case 'text':
      return system.content
    case 'user_added':
      return t('userAdded', { actor: label(system.by), target: label(system.id) })
    case 'user_remove':
      return t('userRemoved', { actor: label(system.by), target: label(system.id) })
    case 'user_joined':
      return t('userJoined', { user: label(system.id) })
    case 'user_left':
      return t('userLeft', { user: label(system.id) })
    case 'user_kicked':
      return t('userKicked', { user: label(system.id) })
    case 'user_banned':
      return t('userBanned', { user: label(system.id) })
    case 'channel_renamed':
      return t('channelRenamed', { actor: label(system.by), name: system.name })
    case 'channel_description_changed':
      return t('channelDescriptionChanged', { actor: label(system.by) })
    case 'channel_icon_changed':
      return t('channelIconChanged', { actor: label(system.by) })
    case 'channel_ownership_changed':
      return t('ownershipTransferred', {
        from: label(system.from),
        to: label(system.to),
      })
    case 'message_pinned':
      return t('messagePinned', { actor: label(system.by) })
    case 'message_unpinned':
      return t('messageUnpinned', { actor: label(system.by) })
    case 'call_started':
      return ''
  }
}

function StandardSystemMessageRow({
  message,
  users,
}: {
  message: Message
  users: Record<string, User>
}) {
  const t = useTranslations('chat.system')
  if (!message.system || message.system.type === 'call_started') return null

  const timestamp = formatMessageTimestamp(messageCreatedAt(message))

  return (
    <article
      data-message-id={message._id}
      className={cn(
        'group relative -mx-4 flex min-h-10 items-center gap-3 py-2 text-sm',
        MESSAGE_ROW_PADDING_X,
        'hover:bg-muted/40',
      )}
    >
      <span
        aria-hidden="true"
        className="flex size-8 shrink-0 items-center justify-center rounded-full bg-muted text-base text-muted-foreground"
      >
        •
      </span>
      <p className="min-w-0 text-muted-foreground">
        <span className="text-foreground">
          {systemMessageText(message.system, users, t)}
        </span>{' '}
        <time className="text-xs font-medium" dateTime={timestamp}>
          {timestamp}
        </time>
      </p>
    </article>
  )
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
  const t = useTranslations('chat')
  const ts = useTranslations('chat.system')
  const server = useSyncStore((s) =>
    serverId ? s.servers[serverId] : undefined,
  )
  const member = useSyncStore((s) =>
    serverId ? s.members[`${serverId}:${message.author}`] : undefined,
  )
  const currentMember = useSyncStore((s) =>
    serverId && currentUserId
      ? s.members[`${serverId}:${currentUserId}`]
      : undefined,
  )

  const name = authorLabel(message, users, ts('unknownUser'))
  const authorUser = message.user ?? users[message.author]
  const own = message.author === currentUserId
  const hasContent = Boolean(message.content?.trim())
  const hasAttachments = Boolean(message.attachments?.length)
  const embeds = useMemo(() => visibleEmbeds(message.embeds), [message.embeds])
  const hasEmbeds = embeds.length > 0
  /** Строку с embed не схлопываем, даже если лента пометила её продолжением группы. */
  const isCompact = compact && !hasEmbeds
  const replyId = message.replies?.[0]
  const showReplyQuote = Boolean(replyId && !isCompact)
  const edited = Boolean(
    (message as Message & { edited?: string | null }).edited,
  )
  const createdAt = messageCreatedAt(message)
  const timestamp = formatMessageTimestamp(createdAt)
  const nameColor = memberDisplayColor(server, member)
  const authorRoles =
    server && member ? memberRoleEntries(server, member) : undefined
  const hideAuthorMessage = authorUser?._id === currentUserId
  const channels = useSyncStore((s) => s.channels)
  const currentUser = currentUserId ? users[currentUserId] : undefined
  const mentionsCurrentUser = isMessageMentioningUser(message, currentUserId, {
    member: currentMember,
    currentUser,
  })
  const members = useSyncStore((s) => s.members)

  const renderedContent = useMemo(
    () =>
      hasContent
        ? renderMessageContent(message.content!, users, emojis, {
            roles: server?.roles,
            channels,
            server,
            serverId,
            serverName: server?.name,
            members,
            currentUserId,
          })
        : null,
    [
      channels,
      currentUserId,
      emojis,
      hasContent,
      members,
      message.content,
      server,
      serverId,
      users,
    ],
  )

  if (message.system?.type === 'call_started') {
    return (
      <VoiceCallSystemCard
        message={message}
        users={users}
        serverId={serverId}
        currentUserId={currentUserId}
      />
    )
  }

  if (message.system) {
    return <StandardSystemMessageRow message={message} users={users} />
  }

  const row = (
    <article
      data-message-id={message._id}
      className={cn(
        'group relative -mx-4 flex items-start hover:bg-muted/40',
        isCompact
          ? cn('min-h-5.5 py-0.5', MESSAGE_COMPACT_CONTENT_INSET)
          : cn('mt-4.25 gap-4 py-0.5', MESSAGE_ROW_PADDING_X),
        highlighted && 'bg-primary/10 hover:bg-primary/15',
        mentionsCurrentUser &&
          !highlighted &&
          'bg-chart-2/10 hover:bg-chart-2/15',
      )}
    >
      {isCompact ? (
        <time
          dateTime={formatMessageTimestamp(createdAt)}
          className={MESSAGE_COMPACT_TIME_CLASS}
        >
          {formatMessageTimeShort(createdAt)}
        </time>
      ) : null}

      {!isCompact ? (
      <div
        className={cn(
          MESSAGE_AVATAR_COLUMN,
          showReplyQuote && 'mt-5',
        )}
      >
        {authorUser ? (
          <MessageAuthorProfileTrigger
            user={authorUser}
            serverId={serverId}
            serverName={server?.name}
            roles={authorRoles}
            hideMessage={hideAuthorMessage}
          >
            <button
              type="button"
              className="rounded-full transition-shadow hover:shadow-md focus-visible:ring-2 focus-visible:ring-ring"
            >
              <UserAvatar
                user={authorUser}
                className="size-10"
                fallbackClassName="size-10"
                showPresence={false}
              />
            </button>
          </MessageAuthorProfileTrigger>
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

        {!isCompact ? (
          <header className="mb-0.5 flex min-h-5 items-baseline gap-2 text-base leading-snug">
            {authorUser ? (
              <MessageAuthorProfileTrigger
                user={authorUser}
                serverId={serverId}
                serverName={server?.name}
                roles={authorRoles}
                hideMessage={hideAuthorMessage}
              >
                <button
                  type="button"
                  className={cn(
                    'max-w-full truncate rounded-sm font-semibold text-left',
                    nameColor && 'text-(--author-name-color)',
                    'hover:underline focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none',
                  )}
                  style={
                    nameColor
                      ? ({ '--author-name-color': nameColor } as CSSVars)
                      : undefined
                  }
                >
                  {name}
                </button>
              </MessageAuthorProfileTrigger>
            ) : (
              <span
                className={cn(
                  'truncate font-semibold',
                  nameColor && 'text-(--author-name-color)',
                )}
                style={
                  nameColor
                    ? ({ '--author-name-color': nameColor } as CSSVars)
                    : undefined
                }
              >
                {name}
              </span>
            )}
            <time
              className="shrink-0 text-xs font-medium leading-5.5 text-muted-foreground"
              dateTime={timestamp}
            >
              {timestamp}
            </time>
            {message.pinned ? (
              <PinIcon
                className="size-3 shrink-0 text-primary"
                aria-label={ts('pinned')}
              />
            ) : null}
            {edited ? (
              <span className="shrink-0 text-xs text-muted-foreground">
                {ts('edited')}
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
            compact={isCompact}
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

        <div className="flex flex-col gap-1 text-base leading-snug text-foreground">
          {hasContent ? (
            <div className="select-text break-words">{renderedContent}</div>
          ) : null}
          {hasAttachments ? (
            <MessageAttachments
              attachments={message.attachments!}
              author={{
                user: authorUser,
                name,
                nameColor,
                createdAt,
              }}
            />
          ) : null}
          {hasEmbeds ? <MessageEmbeds embeds={embeds} /> : null}
          {!hasContent && !hasAttachments && !hasEmbeds ? (
            <p className="text-xs text-muted-foreground italic">
              {ts('systemMessage')}
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

  if (!onReply) return row

  return (
    <ContextMenu>
      <ContextMenuTrigger render={row} />
      <ContextMenuContent className="w-36">
        <ContextMenuItem onClick={() => onReply(message)}>
          <ReplyIcon className="size-4" />
          {t('reply')}
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  )
}
