import { useRef, useState, type ReactNode } from 'react'
import { useTranslations } from '@syrnike13/ui/i18n'
import { MessageSquareIcon, XIcon } from '#/components/icons'
import { Effect } from 'effect'

import { ChannelPinnedDialog } from '#/components/chat/channel-pinned-dialog'
import { MessageSearch } from '#/components/chat/message-search'
import { GroupManagementDialog } from '#/components/chat/group-management-dialog'
import { ChannelIntro } from '#/components/chat/channel-intro'
import { MessageComposer } from '#/components/chat/message-composer'
import {
  MessageList,
  type MessageListHandle,
} from '#/components/chat/message-list'
import { TypingIndicator } from '#/components/chat/typing-indicator'
import { ChannelSettingsDialog } from '#/components/channels/channel-settings-dialog'
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
import { Button } from '@syrnike13/ui/primitives/button'
import { Empty, EmptyDescription } from '@syrnike13/ui/primitives/empty'
import { blockUserRelationship } from '#/features/friends/friend-actions'
import {
  editChannelMessageEffect,
  reactToMessageEffect,
  sendChannelMessageEffect,
  unreactFromMessageEffect,
} from '#/features/api/messages-api'
import { useChannelChat } from '#/features/chat/use-channel-chat'
import { syncStore } from '#/features/sync/sync-store'
import { getChannelLabel, getDmRecipientId } from '#/features/sync/channel-label'
import {
  FLOATING_BAR_BOTTOM_CLASS,
  FLOATING_BAR_BOTTOM_OFFSET_PX,
  FLOATING_BAR_INSET_X_CLASS,
} from '#/components/layout/shell-chrome'
import type { CSSVars } from '#/lib/css-vars'
import { cn } from '#/lib/utils'
import { canMessageUser } from '#/features/authorization/authorization'

type ChannelChatPanelProps = {
  channelId: string
  highlightMessageId?: string
  onClose: () => void
}

export function ChannelChatPanel({
  channelId,
  highlightMessageId,
  onClose,
}: ChannelChatPanelProps) {
  const t = useTranslations('chat')
  const tf = useTranslations('friends')
  const tu = useTranslations('users')
  const [composerHeight, setComposerHeight] = useState(56)
  const [blockUserId, setBlockUserId] = useState<string | null>(null)
  const messageListRef = useRef<MessageListHandle>(null)
  const chat = useChannelChat({
    channelId,
    highlightMessageId,
    enabled: true,
  })

  const {
    auth,
    channel,
    users,
    messages,
    token,
    historyQuery,
    serverIdForSelection,
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
    jumpMessageId,
    editLastOwnMessage,
    notifyTyping,
    stopTyping,
  } = chat

  if (!channel) {
    return (
      <aside className="theme-surface-content gradient-surface-content flex h-full w-full flex-col border-l border-shell-divider text-card-foreground">
        <PanelHeader title={t('panelChat')} onClose={onClose} />
        <Empty size="page">
          <EmptyDescription>{t('channelNotFound')}</EmptyDescription>
        </Empty>
      </aside>
    )
  }

  const title = getChannelLabel(channel, users, auth.user?._id, t)
  const dmRecipientId = getDmRecipientId(channel, auth.user?._id)
  const dmRecipientRelationship = dmRecipientId
    ? users[dmRecipientId]?.relationship
    : undefined
  const dmMessagesBlocked =
    Boolean(dmRecipientId && !canMessageUser(dmRecipientId))
  const dmDisabledPlaceholder =
    dmRecipientRelationship === 'Blocked'
      ? t('blockedByYou')
      : dmRecipientRelationship === 'BlockedOther'
        ? t('blockedYou')
        : dmMessagesBlocked
          ? t('cannotSend')
          : undefined

  return (
    <>
    <aside className="theme-surface-content gradient-surface-content flex h-full min-h-0 w-full flex-col border-l border-shell-divider text-card-foreground">
      <PanelHeader title={title} onClose={onClose}>
        {historyQuery.isFetching ? (
          <span className="text-xs text-muted-foreground">{t('loadingShort')}</span>
        ) : null}
        {channel.channel_type === 'TextChannel' ? (
          <ChannelSettingsDialog channel={channel} />
        ) : null}
        {channel.channel_type === 'Group' ? (
          <GroupManagementDialog channel={channel} />
        ) : null}
        {token ? (
          <>
            <ChannelPinnedDialog
              channelId={channelId}
              token={token}
              users={users}
            />
            <MessageSearch
              scope={{ kind: 'channel', channelId }}
              token={token}
              users={users}
              variant="icon"
            />
          </>
        ) : null}
      </PanelHeader>

      <div
        className="relative flex min-h-0 flex-1 flex-col overflow-hidden pb-(--chat-feed-inset)"
        style={
          {
            '--chat-feed-inset': `${composerHeight / 2}px`,
          } as CSSVars
        }
      >
        <MessageList
          ref={messageListRef}
          channelId={channelId}
          serverId={serverIdForSelection ?? undefined}
          scrollPaddingBottom={composerHeight + 48}
          scrollbarInsetBottom={
            composerHeight / 2 + FLOATING_BAR_BOTTOM_OFFSET_PX
          }
          highlightMessageId={replyTo?._id ?? editingMessage?._id}
          jumpMessageId={jumpMessageId}
          intro={
            channel ? (
              <ChannelIntro
                channel={channel}
                users={users}
                currentUserId={auth.user?._id}
              />
            ) : null
          }
          messages={messages}
          users={users}
          currentUserId={auth.user?._id}
          hasOlder={hasOlder}
          loadingOlder={loadingOlder}
          onLoadOlder={loadOlder}
          onJumpToMessage={jumpToMessage}
          onReply={(message) => setComposerAction({ type: 'reply', message })}
          onEdit={(message) => setComposerAction({ type: 'edit', message })}
          onDelete={(message) => void handleDelete(message)}
          onBlock={(message) => {
            if (!token || message.author === auth.user?._id) return
            setBlockUserId(message.author)
          }}
          onPin={(message) => void handlePin(message)}
          onUnpin={(message) => void handleUnpin(message)}
          onToggleReaction={async (messageId, emoji, active) => {
            if (!token || !auth.user?._id) return
            const userId = auth.user._id

            syncStore.mutateReaction(
              channelId,
              messageId,
              emoji,
              userId,
              !active,
            )

            await Effect.runPromise(
              (
                active
                  ? unreactFromMessageEffect(
                      token,
                      channelId,
                      messageId,
                      emoji,
                    )
                  : reactToMessageEffect(
                      token,
                      channelId,
                      messageId,
                      emoji,
                    )
              ).pipe(
                Effect.catch(() =>
                  Effect.sync(() => {
                    syncStore.mutateReaction(
                      channelId,
                      messageId,
                      emoji,
                      userId,
                      active,
                    )
                  }),
                ),
              ),
            )
          }}
        />

        <div
          className={cn(
            'pointer-events-none absolute z-20 flex flex-col items-stretch gap-1',
            FLOATING_BAR_INSET_X_CLASS,
            FLOATING_BAR_BOTTOM_CLASS,
          )}
        >
          <TypingIndicator channelId={channelId} floating />
          <MessageComposer
            channel={channel}
            users={users}
            onHeightChange={setComposerHeight}
            disabled={
              !token || auth.gatewayState !== 'connected' || dmMessagesBlocked
            }
            disabledPlaceholder={dmDisabledPlaceholder}
            token={token}
            replyTo={replyTo}
            editingMessage={editingMessage}
            onCancelAction={() => setComposerAction(null)}
            onEditLast={editLastOwnMessage}
            onTyping={notifyTyping}
            onStopTyping={stopTyping}
            onSend={async (input) => {
              if (!token) return
              await Effect.runPromise(
                sendChannelMessageEffect(token, channelId, input),
              )
              messageListRef.current?.scrollToEnd('smooth')
            }}
            onEdit={async (messageId, content) => {
              if (!token) return
              await Effect.runPromise(
                editChannelMessageEffect(
                  token,
                  channelId,
                  messageId,
                  content,
                ).pipe(
                  Effect.tap((updated) =>
                    Effect.sync(() =>
                      syncStore.patchMessage(channelId, messageId, updated),
                    ),
                  ),
                ),
              )
            }}
          />
        </div>
      </div>
    </aside>

    <AlertDialog
      open={Boolean(blockUserId)}
      onOpenChange={(open) => {
        if (!open) setBlockUserId(null)
      }}
    >
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{t('blockConfirm')}</AlertDialogTitle>
          <AlertDialogDescription>
            {tu('blockDescription')}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>{t('cancel')}</AlertDialogCancel>
          <AlertDialogAction
            variant="destructive"
            onClick={() => {
              if (!token || !blockUserId) return
              const userId = blockUserId
              setBlockUserId(null)
              Effect.runFork(
                blockUserRelationship(token, userId, tf).pipe(Effect.ignore),
              )
            }}
          >
            {t('block')}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
    </>
  )
}

function PanelHeader({
  title,
  onClose,
  children,
}: {
  title: string
  onClose: () => void
  children?: ReactNode
}) {
  const t = useTranslations('chat')
  return (
    <header className="flex h-12 shrink-0 items-center gap-2 border-b border-shell-divider px-3">
      <MessageSquareIcon className="size-4 shrink-0 text-muted-foreground" />
      <h2 className="min-w-0 flex-1 truncate text-base leading-5 font-medium tracking-tight">
        {title}
      </h2>
      {children}
      <Button
        type="button"
        variant="ghost"
        size="icon"
        className="size-8 shrink-0"
        title={t('closeChat')}
        onClick={onClose}
      >
        <XIcon className="size-4" />
      </Button>
    </header>
  )
}
