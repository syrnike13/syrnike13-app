import { HeadphonesIcon } from 'lucide-react'
import { toast } from 'sonner'

import { VoiceChannelShell } from '#/components/voice/voice-channel-shell'
import { Button } from '#/components/ui/button'
import { ChannelSettingsDialog } from '#/components/channels/channel-settings-dialog'
import { ChannelMemberSidebar } from '#/components/chat/channel-member-sidebar'
import { ChannelPinnedDialog } from '#/components/chat/channel-pinned-dialog'
import { ChannelSearchDialog } from '#/components/chat/channel-search-dialog'
import { MessageComposer } from '#/components/chat/message-composer'
import { MessageList } from '#/components/chat/message-list'
import { TypingIndicator } from '#/components/chat/typing-indicator'
import { useChannelChat } from '#/features/chat/use-channel-chat'
import { getChannelDescription } from '#/lib/channel-meta'
import { getChannelLabel, getDmRecipientId } from '#/features/sync/channel-label'
import { presenceLabel } from '#/lib/presence'
import { useVoice } from '#/features/voice/voice-provider'
import {
  FLOATING_BAR_BOTTOM_CLASS,
  FLOATING_BAR_INSET_X_CLASS,
  FLOATING_BAR_SCROLL_PAD_CLASS,
} from '#/components/layout/shell-chrome'
import { cn } from '#/lib/utils'
import { VoiceTextChannelDock } from '#/components/voice/voice-text-channel-dock'
import { channelHasVoice, isServerVoiceChannel } from '#/lib/channel-voice'
import { blockUser } from '#/features/api/users-api'
import {
  reactToMessage,
  sendChannelMessage,
  editChannelMessage,
  unreactFromMessage,
} from '#/features/api/messages-api'
import { syncStore } from '#/features/sync/sync-store'

type ChannelViewProps = {
  channelId: string
  highlightMessageId?: string
}

export function ChannelView({
  channelId,
  highlightMessageId,
}: ChannelViewProps) {
  const voice = useVoice()
  const chat = useChannelChat({ channelId, highlightMessageId })

  const {
    auth,
    channel,
    users,
    messages,
    token,
    historyQuery,
    serverIdForSelection,
    isServerChannel,
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
    listHighlightMessageId,
    notifyTyping,
  } = chat

  if (!channel) {
    return (
      <div className="flex flex-1 items-center justify-center text-muted-foreground">
        Канал не найден
      </div>
    )
  }

  if (isServerVoiceChannel(channel)) {
    return (
      <VoiceChannelShell
        channelId={channelId}
        highlightMessageId={highlightMessageId}
      />
    )
  }

  const title = getChannelLabel(channel, users, auth.user?._id)
  const channelDescription = getChannelDescription(channel)
  const hasVoice = channelHasVoice(channel)
  const inThisVoiceCall =
    voice.channelId === channelId && voice.status === 'connected'
  const dmRecipientId = getDmRecipientId(channel, auth.user?._id)
  const dmRecipient = dmRecipientId ? users[dmRecipientId] : undefined

  return (
    <div className="flex min-h-0 min-w-0 flex-1">
      <div className="relative flex min-h-0 min-w-0 flex-1 flex-col">
        <header className="flex h-12 shrink-0 items-center gap-2 border-b border-shell-divider px-4">
          <div className="min-w-0 flex-1">
            <h1 className="truncate font-semibold">{title}</h1>
            {channel.channel_type === 'DirectMessage' && dmRecipient ? (
              <p className="text-xs text-muted-foreground">
                {presenceLabel(dmRecipient)}
              </p>
            ) : channelDescription ? (
              <p className="line-clamp-2 text-xs text-muted-foreground">
                {channelDescription}
              </p>
            ) : null}
          </div>
          {historyQuery.isFetching ? (
            <span className="text-xs text-muted-foreground">загрузка…</span>
          ) : null}
          {hasVoice ? (
            <Button
              type="button"
              size="sm"
              variant={inThisVoiceCall ? 'secondary' : 'outline'}
              onClick={() =>
                inThisVoiceCall ? voice.leave() : void voice.join(channelId)
              }
            >
              <HeadphonesIcon className="size-4" />
              {inThisVoiceCall ? 'В голосе' : 'Голос'}
            </Button>
          ) : null}
          {isServerChannel ? (
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
        </header>

        <div className="relative flex min-h-0 flex-1 flex-col overflow-hidden">
          {hasVoice && inThisVoiceCall && channel.channel_type === 'TextChannel' ? (
            <VoiceTextChannelDock channelId={channelId} />
          ) : null}
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
            onDelete={(message) => void handleDelete(message)}
            onBlock={(message) => {
              if (!token || message.author === auth.user?._id) return
              if (!window.confirm('Заблокировать этого пользователя?')) return
              void blockUser(token, message.author)
                .then((user) => syncStore.upsertUser(user))
                .catch((error) =>
                  toast.error(
                    error instanceof Error
                      ? error.message
                      : 'Не удалось заблокировать',
                  ),
                )
            }}
            onPin={(message) => void handlePin(message)}
            onUnpin={(message) => void handleUnpin(message)}
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
      </div>
      {isServerChannel && channel.channel_type === 'TextChannel' ? (
        <ChannelMemberSidebar channel={channel} />
      ) : null}
    </div>
  )
}
