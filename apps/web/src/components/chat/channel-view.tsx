import {
  useEffect,
  useState,
  type PointerEvent as ReactPointerEvent,
} from 'react'
import { HeadphonesIcon, UserIcon, UsersIcon } from '#/components/icons'

import { VoiceChannelShell } from '#/components/voice/voice-channel-shell'
import { VoiceStageView } from '#/components/voice/voice-stage-view'
import { Button } from '#/components/ui/button'
import { ChannelSettingsDialog } from '#/components/channels/channel-settings-dialog'
import { ChannelMemberSidebar } from '#/components/chat/channel-member-sidebar'
import { DirectMessageProfilePanel } from '#/components/chat/direct-message-profile-panel'
import { VoiceCallBanner } from '#/components/voice/voice-call-banner'
import { ChannelPinnedDialog } from '#/components/chat/channel-pinned-dialog'
import { ChannelSearchDialog } from '#/components/chat/channel-search-dialog'
import { ServerChannelSearchPopover } from '#/components/chat/server-channel-search-popover'
import { MessageComposer } from '#/components/chat/message-composer'
import { MessageList } from '#/components/chat/message-list'
import { TypingIndicator } from '#/components/chat/typing-indicator'
import { UserAvatar } from '#/components/user/user-avatar'
import { UserGlobalProfileDialog } from '#/components/user/user-global-profile-dialog'
import { useChannelChat } from '#/features/chat/use-channel-chat'
import { getChannelDescription } from '#/lib/channel-meta'
import { getChannelLabel, getDmRecipientId } from '#/features/sync/channel-label'
import { useVoice } from '#/features/voice/voice-context'
import {
  FLOATING_BAR_BOTTOM_CLASS,
  FLOATING_BAR_INSET_X_CLASS,
  FLOATING_BAR_SCROLL_PAD_CLASS,
  shellColumnHeaderClass,
} from '#/components/layout/shell-chrome'
import { cn } from '#/lib/utils'
import { VoiceTextChannelDock } from '#/components/voice/voice-text-channel-dock'
import { channelHasVoice, isServerVoiceChannel } from '#/lib/channel-voice'
import { blockUserRelationship } from '#/features/friends/friend-actions'
import { closeVoiceCallNotification } from '#/features/notifications/voice-call-notifications'
import {
  reactToMessage,
  sendChannelMessage,
  editChannelMessage,
  unreactFromMessage,
} from '#/features/api/messages-api'
import { cancelDirectMessageCall } from '#/features/api/channels-api'
import {
  listUserMutualServerNicknames,
} from '#/features/sync/selectors'
import { syncStore, useSyncStore } from '#/features/sync/sync-store'
import {
  isIncomingVoiceCall,
  isVoiceCallDismissed,
  isVoiceCallRingingDismissed,
} from '#/features/sync/voice-call-utils'
import type { User } from '@syrnike13/api-types'

type ChannelViewProps = {
  channelId: string
  highlightMessageId?: string
}

const EMPTY_ALIASES: string[] = []
const INLINE_VOICE_STAGE_DEFAULT_HEIGHT = 300
const INLINE_VOICE_STAGE_MIN_HEIGHT = 220
const INLINE_VOICE_STAGE_MAX_HEIGHT = 560

function clampInlineVoiceStageHeight(height: number, viewportHeight?: number) {
  const viewportMax =
    viewportHeight == null
      ? INLINE_VOICE_STAGE_MAX_HEIGHT
      : Math.min(INLINE_VOICE_STAGE_MAX_HEIGHT, viewportHeight * 0.6)

  return Math.min(
    Math.max(INLINE_VOICE_STAGE_MIN_HEIGHT, viewportMax),
    Math.max(INLINE_VOICE_STAGE_MIN_HEIGHT, height),
  )
}

function DirectMessageHeader({
  user,
  title,
  aliases,
  onOpenProfile,
}: {
  user: User
  title: string
  aliases: string[]
  onOpenProfile: () => void
}) {
  return (
    <div className="flex min-w-0 flex-1 items-center gap-2">
      <UserAvatar
        user={user}
        className="size-8"
        fallbackClassName="size-8 text-xs"
        showPresence
        presenceRingClassName="border-card"
      />
      <div className="flex min-w-0 flex-1 items-center gap-2">
        <h1 className="min-w-0 font-semibold">
          <button
            type="button"
            className="block max-w-full truncate rounded-sm text-left font-semibold transition-colors hover:text-foreground/80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            onClick={onOpenProfile}
          >
            {title}
          </button>
        </h1>
        {aliases.length > 0 ? (
          <>
            <span className="shrink-0 text-muted-foreground/50">|</span>
            <span className="shrink-0 text-xs font-semibold text-foreground">
              AKA
            </span>
            <span className="min-w-0 truncate text-sm text-muted-foreground">
              {aliases.join(', ')}
            </span>
          </>
        ) : null}
      </div>
    </div>
  )
}

export function ChannelView({
  channelId,
  highlightMessageId,
}: ChannelViewProps) {
  const voice = useVoice()
  const chat = useChannelChat({ channelId, highlightMessageId })
  const [dmProfilePanelOpen, setDmProfilePanelOpen] = useState(true)
  const [fullProfileOpen, setFullProfileOpen] = useState(false)
  const [inlineVoiceStageHeight, setInlineVoiceStageHeight] = useState(
    INLINE_VOICE_STAGE_DEFAULT_HEIGHT,
  )

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

  useEffect(() => {
    setDmProfilePanelOpen(true)
    setFullProfileOpen(false)
  }, [channelId])

  const currentUserId = auth.user?._id
  const voiceCall = useSyncStore((s) => s.voiceCalls[channelId])
  const voiceCallRingingDismissed = useSyncStore((s) =>
    isVoiceCallRingingDismissed(voiceCall, s.dismissedVoiceCallKeys),
  )
  const voiceCallDismissed = useSyncStore((s) =>
    isVoiceCallDismissed(voiceCall, s.dismissedVoiceCallKeys),
  )
  const dmRecipientId = channel
    ? getDmRecipientId(channel, currentUserId)
    : undefined
  const dmAliases = useSyncStore((s) =>
    dmRecipientId
      ? listUserMutualServerNicknames(s, dmRecipientId, currentUserId)
      : EMPTY_ALIASES,
  )

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
  const isDirectMessage = channel.channel_type === 'DirectMessage'
  const isGroupDirectMessage = channel.channel_type === 'Group'
  const isDmVoiceCallChannel =
    channel.channel_type === 'DirectMessage' || channel.channel_type === 'Group'
  const dmRecipient = dmRecipientId ? users[dmRecipientId] : undefined
  const hasBotRecipient = isDmVoiceCallChannel
    ? channel.recipients.some((recipientId) => Boolean(users[recipientId]?.bot))
    : false
  const hasVoice = channelHasVoice(channel) && !hasBotRecipient
  const inThisVoiceSession =
    voice.channelId === channelId &&
    (voice.status === 'connected' || voice.status === 'connecting')
  const inThisVoiceCall =
    voice.channelId === channelId &&
    voice.status === 'connected'
  const voiceCallIncoming = isIncomingVoiceCall(voiceCall, currentUserId)
  const showInlineVoiceStage =
    hasVoice &&
    isDmVoiceCallChannel &&
    (inThisVoiceSession ||
      (voiceCall?.phase === 'active' && !voiceCallDismissed))
  let voiceActionLabel = isDmVoiceCallChannel ? 'Позвонить' : 'Голос'
  if (
    (isDmVoiceCallChannel && voiceCall?.phase === 'active') ||
    (isGroupDirectMessage && voiceCall)
  ) {
    voiceActionLabel = 'Присоединиться'
  } else if (
    isDmVoiceCallChannel &&
    !voiceCallRingingDismissed &&
    voiceCallIncoming
  ) {
    voiceActionLabel = 'Ответить'
  }
  const showVoiceCallBanner =
    Boolean(voiceCall) &&
    !inThisVoiceSession &&
    !showInlineVoiceStage &&
    !voiceCallRingingDismissed &&
    voiceCallIncoming
  const showMemberSidebar =
    isServerChannel && channel.channel_type === 'TextChannel'
  const voiceCallInitiator = voiceCall ? users[voiceCall.initiatorId] : undefined
  const voiceCallInitiatorName =
    voiceCallInitiator?.display_name ??
    voiceCallInitiator?.username ??
    'Пользователь'
  function dismissVoiceCallBanner() {
    if (!voiceCall) return

    if (isDirectMessage && voiceCall.phase === 'ringing') {
      if (!token) return

      void cancelDirectMessageCall(token, channelId)
        .then(() => {
          syncStore.removeVoiceCall(channelId)
          void closeVoiceCallNotification(channelId)
        })
        .catch(() => undefined)
      return
    }

    syncStore.dismissVoiceCall(voiceCall)
    void closeVoiceCallNotification(channelId)
  }

  function startInlineVoiceStageResize(
    event: ReactPointerEvent<HTMLDivElement>,
  ) {
    event.preventDefault()

    const startY = event.clientY
    const startHeight = inlineVoiceStageHeight

    function handlePointerMove(moveEvent: PointerEvent) {
      setInlineVoiceStageHeight(
        clampInlineVoiceStageHeight(
          startHeight + moveEvent.clientY - startY,
          window.innerHeight,
        ),
      )
    }

    function stopResize() {
      window.removeEventListener('pointermove', handlePointerMove)
      window.removeEventListener('pointerup', stopResize)
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
    }

    document.body.style.cursor = 'row-resize'
    document.body.style.userSelect = 'none'
    window.addEventListener('pointermove', handlePointerMove)
    window.addEventListener('pointerup', stopResize, { once: true })
  }

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <header className={cn(shellColumnHeaderClass, 'bg-card px-0')}>
        <div className="flex min-w-0 flex-1 items-center gap-2 px-4">
          {isDirectMessage && dmRecipient ? (
            <DirectMessageHeader
              user={dmRecipient}
              title={title}
              aliases={dmAliases}
              onOpenProfile={() => setDmProfilePanelOpen(true)}
            />
          ) : isGroupDirectMessage ? (
            <div className="flex min-w-0 flex-1 items-center gap-2">
              <span
                title="Групповой чат"
                className="flex size-5 shrink-0 items-center justify-center text-muted-foreground"
              >
                <UsersIcon aria-hidden="true" className="size-5" />
              </span>
              <h1 className="truncate font-semibold">{title}</h1>
            </div>
          ) : (
            <div className="min-w-0 flex-1">
              <h1 className="truncate font-semibold">{title}</h1>
              {channelDescription ? (
                <p className="line-clamp-2 text-xs text-muted-foreground">
                  {channelDescription}
                </p>
              ) : null}
            </div>
          )}
          {historyQuery.isFetching ? (
            <span className="text-xs text-muted-foreground">загрузка…</span>
          ) : null}
          {isDirectMessage && dmRecipient ? (
            <Button
              type="button"
              size="sm"
              variant={dmProfilePanelOpen ? 'secondary' : 'ghost'}
              aria-pressed={dmProfilePanelOpen}
              title={dmProfilePanelOpen ? 'Скрыть профиль' : 'Показать профиль'}
              onClick={() => setDmProfilePanelOpen((open) => !open)}
            >
              <UserIcon className="size-4" />
              Профиль
            </Button>
          ) : null}
          {hasVoice && !inThisVoiceSession ? (
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={() => void voice.join(channelId)}
            >
              <HeadphonesIcon className="size-4" />
              {voiceActionLabel}
            </Button>
          ) : null}
          {channel.channel_type === 'TextChannel' ? (
            <ChannelSettingsDialog channel={channel} />
          ) : null}
          {token ? (
            <ChannelPinnedDialog
              channelId={channelId}
              token={token}
              users={users}
            />
          ) : null}
          {token && showMemberSidebar ? (
            <div className="lg:hidden">
              <ServerChannelSearchPopover
                serverId={channel.server}
                token={token}
                users={users}
                variant="icon"
              />
            </div>
          ) : null}
          {token && !showMemberSidebar ? (
            <ChannelSearchDialog
              channelId={channelId}
              token={token}
              users={users}
            />
          ) : null}
        </div>
        {token && showMemberSidebar ? (
          <div className="hidden h-full w-52 shrink-0 items-center px-2 lg:flex">
            <ServerChannelSearchPopover
              serverId={channel.server}
              token={token}
              users={users}
            />
          </div>
        ) : null}
      </header>

      <div className="flex min-h-0 min-w-0 flex-1">
        <div className="relative flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
          {showInlineVoiceStage &&
          (channel.channel_type === 'DirectMessage' ||
            channel.channel_type === 'Group') ? (
            <section
              aria-label="Голосовой звонок"
              className="relative shrink-0 overflow-hidden border-b border-shell-divider bg-black"
              style={{
                height: inlineVoiceStageHeight,
                minHeight: INLINE_VOICE_STAGE_MIN_HEIGHT,
                maxHeight: '60vh',
              }}
            >
              <VoiceStageView
                channel={channel}
                title={title}
                chatOpen={false}
                onToggleChat={() => undefined}
                showChatToggle={false}
              />
              <div
                aria-label="Изменить высоту звонка"
                aria-orientation="horizontal"
                className="absolute inset-x-0 bottom-0 z-[70] h-2 cursor-row-resize touch-none bg-transparent transition-colors hover:bg-white/20"
                role="separator"
                onPointerDown={startInlineVoiceStageResize}
              />
            </section>
          ) : null}
          {hasVoice && inThisVoiceCall && !showInlineVoiceStage ? (
            <VoiceTextChannelDock channelId={channelId} />
          ) : null}
          {showVoiceCallBanner && voiceCall ? (
            <VoiceCallBanner
              title={isDirectMessage ? 'Личный звонок' : 'Групповой звонок'}
              detail={
                voiceCall.phase === 'ringing'
                  ? `${voiceCallInitiatorName} звонит`
                  : 'Звонок уже идёт'
              }
              actionLabel="Ответить"
              dismissLabel={
                isDirectMessage && voiceCall.phase === 'ringing'
                  ? 'Отменить'
                  : 'Скрыть'
              }
              onJoin={() => {
                void voice.join(channelId)
              }}
              onDismiss={dismissVoiceCallBanner}
            />
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
              void blockUserRelationship(token, message.author).catch(
                () => undefined,
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
        {isDirectMessage && dmRecipient && dmProfilePanelOpen ? (
          <DirectMessageProfilePanel
            user={dmRecipient}
            currentUserId={auth.user?._id}
            token={token}
            aliases={dmAliases}
            callActionLabel={voiceActionLabel}
            showCallAction={!voiceCall && !hasBotRecipient}
            onStartCall={() => {
              void voice.join(channelId)
            }}
            onViewFullProfile={() => setFullProfileOpen(true)}
          />
        ) : showMemberSidebar && channel.channel_type === 'TextChannel' ? (
          <ChannelMemberSidebar channel={channel} />
        ) : null}
      </div>
      {fullProfileOpen && dmRecipient ? (
        <UserGlobalProfileDialog
          user={dmRecipient}
          open={fullProfileOpen}
          onOpenChange={setFullProfileOpen}
        />
      ) : null}
    </div>
  )
}
