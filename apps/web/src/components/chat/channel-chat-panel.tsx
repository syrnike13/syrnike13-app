import { useState, type ReactNode } from 'react'
import type { Message } from '@syrnike13/api-types'
import { MessageSquareIcon, XIcon } from '#/components/icons'

import { ChannelPinnedDialog } from '#/components/chat/channel-pinned-dialog'
import { ChannelSearchDialog } from '#/components/chat/channel-search-dialog'
import { MessageComposer } from '#/components/chat/message-composer'
import { MessageList } from '#/components/chat/message-list'
import {
  MessageActionConfirmationDialog,
  type ChatMessageAction,
} from '#/components/chat/message-action-confirmation-dialog'
import { TypingIndicator } from '#/components/chat/typing-indicator'
import { ChannelSettingsDialog } from '#/components/channels/channel-settings-dialog'
import { Button } from '#/components/ui/button'
import { blockUserRelationship } from '#/features/friends/friend-actions'
import {
  reactToMessage,
  sendChannelMessage,
  editChannelMessage,
  unreactFromMessage,
} from '#/features/api/messages-api'
import { useChannelChat } from '#/features/chat/use-channel-chat'
import { syncStore } from '#/features/sync/sync-store'
import { getChannelLabel } from '#/features/sync/channel-label'
import {
  FLOATING_BAR_BOTTOM_CLASS,
  FLOATING_BAR_INSET_X_CLASS,
  FLOATING_BAR_SCROLL_PAD_CLASS,
} from '#/components/layout/shell-chrome'
import { cn } from '#/lib/utils'

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
  const chat = useChannelChat({
    channelId,
    highlightMessageId,
    enabled: true,
  })
  const [pendingMessageAction, setPendingMessageAction] =
    useState<ChatMessageAction | null>(null)

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
    handleClearReactions,
    canClearMessageReactions,
    jumpToMessage,
    replyTo,
    editingMessage,
    listHighlightMessageId,
    notifyTyping,
  } = chat

  if (!channel) {
    return (
      <aside className="flex h-full w-full flex-col border-l border-shell-divider bg-background">
        <PanelHeader title="Чат" onClose={onClose} />
        <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">
          Канал не найден
        </div>
      </aside>
    )
  }

  const title = getChannelLabel(channel, users, auth.user?._id)

  function requestBlockMessageAuthor(message: Message) {
    if (!token || message.author === auth.user?._id) return

    setPendingMessageAction({
      type: 'block',
      message,
      user: users[message.author],
    })
  }

  function confirmMessageAction(action: ChatMessageAction) {
    setPendingMessageAction(null)

    if (action.type === 'delete') {
      void handleDelete(action.message)
      return
    }

    if (action.type === 'clearReactions') {
      void handleClearReactions(action.message)
      return
    }

    if (!token || action.message.author === auth.user?._id) return
    void blockUserRelationship(token, action.message.author).catch(
      () => undefined,
    )
  }

  return (
    <aside className="flex h-full min-h-0 w-full flex-col border-l border-shell-divider bg-background">
      <PanelHeader title={title} onClose={onClose}>
        {historyQuery.isFetching ? (
          <span className="text-xs text-muted-foreground">загрузка…</span>
        ) : null}
        {channel.channel_type === 'TextChannel' ? (
          <ChannelSettingsDialog channel={channel} />
        ) : null}
        {token ? (
          <>
            <ChannelPinnedDialog
              channelId={channelId}
              token={token}
              users={users}
            />
            <ChannelSearchDialog
              channelId={channelId}
              token={token}
              users={users}
            />
          </>
        ) : null}
      </PanelHeader>

      <div className="relative flex min-h-0 flex-1 flex-col overflow-hidden">
        <MessageList
          channelId={channelId}
          serverId={serverIdForSelection ?? undefined}
          scrollPaddingClassName={cn(
            FLOATING_BAR_SCROLL_PAD_CLASS,
            replyTo && 'pb-[88px]',
          )}
          highlightMessageId={listHighlightMessageId}
          messages={messages}
          users={users}
          currentUserId={auth.user?._id}
          hasOlder={hasOlder}
          loadingOlder={loadingOlder}
          onLoadOlder={loadOlder}
          onJumpToMessage={jumpToMessage}
          onReply={(message) => setComposerAction({ type: 'reply', message })}
          onEdit={(message) => setComposerAction({ type: 'edit', message })}
          onDelete={(message) =>
            setPendingMessageAction({ type: 'delete', message })
          }
          onBlock={requestBlockMessageAuthor}
          onPin={(message) => void handlePin(message)}
          onUnpin={(message) => void handleUnpin(message)}
          onClearReactions={
            canClearMessageReactions
              ? (message) =>
                  setPendingMessageAction({
                    type: 'clearReactions',
                    message,
                  })
              : undefined
          }
          onToggleReaction={async (messageId, emoji, active) => {
            if (!token || !auth.user?._id) return

            syncStore.mutateReaction(
              channelId,
              messageId,
              emoji,
              auth.user._id,
              !active,
            )

            try {
              if (active) {
                await unreactFromMessage(token, channelId, messageId, emoji)
              } else {
                await reactToMessage(token, channelId, messageId, emoji)
              }
            } catch {
              syncStore.mutateReaction(
                channelId,
                messageId,
                emoji,
                auth.user._id,
                active,
              )
            }
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
            floating
            disabled={!token || auth.gatewayState !== 'connected'}
            token={token}
            replyTo={replyTo}
            editingMessage={editingMessage}
            onCancelAction={() => setComposerAction(null)}
            onTyping={notifyTyping}
            onSend={async (input) => {
              if (!token) return
              await sendChannelMessage(token, channelId, input)
            }}
            onEdit={async (messageId, content) => {
              if (!token) return
              const updated = await editChannelMessage(
                token,
                channelId,
                messageId,
                content,
              )
              syncStore.patchMessage(channelId, messageId, updated)
            }}
          />
        </div>
      </div>
      <MessageActionConfirmationDialog
        action={pendingMessageAction}
        onOpenChange={(open) => {
          if (!open) setPendingMessageAction(null)
        }}
        onConfirm={confirmMessageAction}
      />
    </aside>
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
  return (
    <header className="flex h-12 shrink-0 items-center gap-2 border-b border-shell-divider px-3">
      <MessageSquareIcon className="size-4 shrink-0 text-muted-foreground" />
      <h2 className="min-w-0 flex-1 truncate text-sm font-semibold">{title}</h2>
      {children}
      <Button
        type="button"
        variant="ghost"
        size="icon"
        className="size-8 shrink-0"
        title="Закрыть чат"
        onClick={onClose}
      >
        <XIcon className="size-4" />
      </Button>
    </header>
  )
}
