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
  MessageNote,
  MessageTimestamp,
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
          'min-w-0 truncate rounded-sm text-left hover:underline focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none',
          nameColor && 'text-(--author-name-color)',
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
    <span className="min-w-0 truncate">{name}</span>
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
    <MessagePrimitive
      data-message-id={message._id}
      groupStart={!isCompact}
      highlighted={highlighted}
      mentioned={mentionsCurrentUser && !highlighted}
    >
      {isCompact ? (
        <MessageTimestamp
          placement="gutter"
          dateTime={createdAt.toISOString()}
          title={timestamp}
        >
          {shortTime}
        </MessageTimestamp>
      ) : (
        <MessageAvatar>
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
                tabIndex={-1}
                aria-hidden
                className="rounded-full focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
              >
                {avatar}
              </button>
            </MessageAuthorProfileTrigger>
          ) : (
            avatar
          )}
        </MessageAvatar>
      )}

      <MessageContent>
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
          <MessageHeader>
            {authorButton}
            <MessageTimestamp dateTime={createdAt.toISOString()}>
              {timestamp}
            </MessageTimestamp>
            {message.pinned ? (
              <PinIcon
                className="size-3 shrink-0 self-center text-muted-foreground"
                aria-label={ts('pinned')}
              />
            ) : null}
          </MessageHeader>
        ) : (
          <span className="sr-only">
            {name}, {timestamp}
          </span>
        )}

        {hasContent ? (
          <div className="select-text">
            {renderedContent}
            {edited ? <MessageNote>{ts('edited')}</MessageNote> : null}
          </div>
        ) : null}

        {hasAttachments || hasEmbeds ? (
          <div className="flex flex-col gap-1 py-0.5">
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
          </div>
        ) : null}

        {!hasContent && !hasAttachments && !hasEmbeds ? (
          <p className="text-muted-foreground italic">{ts('systemMessage')}</p>
        ) : null}

        {onToggleReaction ? (
          <MessageReactions
            message={message}
            users={users}
            currentUserId={currentUserId}
            serverId={serverId}
            onToggle={(emoji, active) =>
              onToggleReaction(message._id, emoji, active)
            }
          />
        ) : null}
      </MessageContent>

      {onReply && onToggleReaction ? (
        <MessageHoverToolbar
          message={message}
          channelId={channelId}
          own={own}
          serverId={serverId}
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
