import { Fragment, useMemo, useState, type ReactElement } from 'react'
import type { Emoji, Member, Message, Server, User } from '@syrnike13/api-types'
import { useTranslations } from '@syrnike13/ui/i18n'
import { PinIcon } from '#/components/icons'

import { InlineReplyQuote, messageAuthorName } from '#/components/chat/message-reply-preview'
import { useMessageActions } from '#/components/chat/message-actions'
import { MessageAttachments } from '#/components/chat/message-attachments'
import { MessageEmbeds, visibleEmbeds } from '#/components/chat/message-embeds'
import { MessageHoverToolbar } from '#/components/chat/message-hover-toolbar'
import { MessageReactions } from '#/components/chat/message-reactions'
import { MessageSystemRow } from '#/components/chat/message-system-row'
import { MESSAGE_COMPACT_TIME_CLASS } from '#/components/chat/message-layout'
import { UserAvatar } from '#/components/user/user-avatar'
import { UserProfilePopover } from '#/components/user/user-profile-popover'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@syrnike13/ui/primitives/alert-dialog'
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from '@syrnike13/ui/primitives/context-menu'
import {
  Message as MessagePrimitive,
  MessageAvatar,
  MessageContent,
  MessageHeader,
} from '@syrnike13/ui/primitives/message'
import {
  memberRoleEntries,
  type MemberRoleEntry,
} from '#/features/sync/selectors'
import { useSyncStore } from '#/features/sync/sync-store'
import { isMessageMentioningUser } from '#/lib/mentions'
import { renderMessageContent } from '#/lib/message-markdown'
import { messageCreatedAt } from '#/lib/message-time'
import { useMessageTimeShort, useMessageTimestamp } from '#/lib/use-message-time'
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
  const formatTimestamp = useMessageTimestamp()
  const formatTimeShort = useMessageTimeShort()
  const [deleteOpen, setDeleteOpen] = useState(false)

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

  const name = messageAuthorName(message, users, ts('unknownUser'))
  const authorUser = message.user ?? users[message.author]
  const avatarOverride =
    message.masquerade?.avatar ?? message.webhook?.avatar ?? undefined
  const own = message.author === currentUserId
  const hasContent = Boolean(message.content?.trim())
  const hasAttachments = Boolean(message.attachments?.length)
  const embeds = useMemo(() => visibleEmbeds(message.embeds), [message.embeds])
  const hasEmbeds = embeds.length > 0
  /** Строку с embed не схлопываем, даже если лента пометила её продолжением группы. */
  const isCompact = compact && !hasEmbeds
  const replyId = message.replies?.[0]
  const showReplyQuote = Boolean(replyId && !isCompact)
  const edited = Boolean(message.edited)
  const createdAt = messageCreatedAt(message)
  const timestamp = formatTimestamp(createdAt)
  const shortTime = formatTimeShort(createdAt)
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

  const requestDelete = onDelete ? () => setDeleteOpen(true) : undefined
  const contextActions = useMessageActions({
    message,
    channelId,
    own,
    onReply: onReply ? () => onReply(message) : () => {},
    onEdit: onEdit ? () => onEdit(message) : undefined,
    onDelete: requestDelete,
    onBlock: onBlock && !own ? () => onBlock(message) : undefined,
    onPin: onPin ? () => onPin(message) : undefined,
    onUnpin: onUnpin ? () => onUnpin(message) : undefined,
  })

  if (message.system) {
    return (
      <MessageSystemRow
        message={message}
        users={users}
        serverId={serverId}
        currentUserId={currentUserId}
      />
    )
  }

  const authorButton = authorUser ? (
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
          'max-w-full truncate rounded-sm text-left font-medium tracking-tight',
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
    <span className="truncate font-medium">{name}</span>
  )

  const avatar = (
    <UserAvatar
      user={authorUser}
      imageSrc={avatarOverride}
      className="size-10"
      fallbackClassName="size-10"
      showPresence={false}
    />
  )

  const row = (
    // design-allow restyle-shared: mention/highlight background is a message state.
    <MessagePrimitive
      data-message-id={message._id}
      className={cn(
        'relative flex w-full min-w-0 items-start gap-4 py-0.5 pr-6 pl-18 hover:bg-hover',
        isCompact ? 'min-h-5.5' : 'mt-4.25',
        highlighted && 'bg-primary/10',
        mentionsCurrentUser && !highlighted && 'bg-chart-2/10',
      )}
    >
      {isCompact ? (
        <time
          dateTime={createdAt.toISOString()}
          className={MESSAGE_COMPACT_TIME_CLASS}
        >
          {shortTime}
        </time>
      ) : null}

      {!isCompact ? (
        <MessageAvatar
          className={
            showReplyQuote
              ? 'absolute top-5.5 left-4 w-10'
              : 'absolute top-0.5 left-4 w-10'
          }
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
                {avatar}
              </button>
            </MessageAuthorProfileTrigger>
          ) : (
            avatar
          )}
        </MessageAvatar>
      ) : null}

      <MessageContent className="relative min-w-0 flex-1 gap-1 text-base leading-5.5">
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
          <MessageHeader className="mb-0.5 flex min-h-5.5 items-baseline gap-2 px-0 text-base leading-snug text-foreground">
            {authorButton}
            <time
              className="shrink-0 text-xs font-medium leading-5.5 text-muted-foreground"
              dateTime={createdAt.toISOString()}
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
          </MessageHeader>
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
            onDelete={requestDelete}
            onBlock={onBlock && !own ? () => onBlock(message) : undefined}
            onPin={onPin ? () => onPin(message) : undefined}
            onUnpin={onUnpin ? () => onUnpin(message) : undefined}
            onToggleReaction={(emoji, active) =>
              onToggleReaction(message._id, emoji, active)
            }
          />
        ) : null}

        <div className="flex flex-col gap-1 text-base leading-5.5 text-foreground">
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
      </MessageContent>
    </MessagePrimitive>
  )

  const deleteDialog = onDelete ? (
    <AlertDialog open={deleteOpen} onOpenChange={setDeleteOpen}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{t('delete')}</AlertDialogTitle>
          <AlertDialogDescription>
            {t('deleteMessageConfirm')}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>{t('cancel')}</AlertDialogCancel>
          <AlertDialogAction
            variant="destructive"
            onClick={() => onDelete(message)}
          >
            {t('delete')}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  ) : null

  if (!onReply) {
    return (
      <>
        {row}
        {deleteDialog}
      </>
    )
  }

  return (
    <>
      <ContextMenu>
        <ContextMenuTrigger render={row} />
        <ContextMenuContent className="w-52">
          {contextActions.map((action) => (
            <Fragment key={action.key}>
              {action.separatorBefore ? <ContextMenuSeparator /> : null}
              <ContextMenuItem
                variant={action.destructive ? 'destructive' : 'default'}
                onClick={action.onSelect}
              >
                {action.icon}
                {action.label}
              </ContextMenuItem>
            </Fragment>
          ))}
        </ContextMenuContent>
      </ContextMenu>
      {deleteDialog}
    </>
  )
}
