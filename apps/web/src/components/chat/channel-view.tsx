import {
  useEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from 'react'
import { useNavigate } from '@tanstack/react-router'
import {
  ChevronLeftIcon,
  HeadphonesIcon,
  PhoneIcon,
  UserIcon,
  UsersIcon,
} from '#/components/icons'

import { VoiceChannelShell } from '#/components/voice/voice-channel-shell'
import { VoiceStageView } from '#/components/voice/voice-stage-view'
import { Button } from '#/components/ui/button'
import { ChannelSettingsDialog } from '#/components/channels/channel-settings-dialog'
import { ChannelMemberSidebar } from '#/components/chat/channel-member-sidebar'
import { DirectMessageProfilePanel } from '#/components/chat/direct-message-profile-panel'
import { GroupManagementDialog } from '#/components/chat/group-management-dialog'
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
import { useAppRoutePrefix } from '#/features/navigation/route-prefix'
import { getChannelLabel, getDmRecipientId } from '#/features/sync/channel-label'
import { useVoiceSession } from '#/features/voice/voice-session-context'
import {
  FLOATING_BAR_BOTTOM_CLASS,
  FLOATING_BAR_INSET_X_CLASS,
  FLOATING_BAR_SCROLL_PAD_CLASS,
  shellChromeSurface,
  shellColumnHeaderClass,
} from '#/components/layout/shell-chrome'
import { cn } from '#/lib/utils'
import { attachmentPreviewUrl } from '#/lib/media'
import { VoiceTextChannelDock } from '#/components/voice/voice-text-channel-dock'
import { channelHasVoice, isServerVoiceChannel } from '#/lib/channel-voice'
import { canMessageUser } from '#/features/authorization/authorization'
import { blockUserRelationship } from '#/features/friends/friend-actions'
import { closeVoiceCallNotification } from '#/features/notifications/voice-call-notifications'
import {
  reactToMessage,
  sendChannelMessage,
  editChannelMessage,
  unreactFromMessage,
} from '#/features/api/messages-api'
import {
  cancelDirectMessageCall,
  declineDirectMessageCall,
} from '#/features/api/channels-api'
import { listUserMutualServerNicknames } from '#/features/sync/selectors'
import { syncStore, useSyncStore } from '#/features/sync/sync-store'
import {
  hasOngoingVoiceCall,
  isIncomingVoiceCall,
  isVoiceCallRingingDismissed,
} from '#/features/sync/voice-call-utils'
import type { User } from '@syrnike13/api-types'

type ChannelViewProps = {
  channelId: string
  highlightMessageId?: string
}

const EMPTY_ALIASES: string[] = []
const INLINE_VOICE_STAGE_DEFAULT_HEIGHT = 360
const INLINE_VOICE_STAGE_MIN_HEIGHT = 220
const INLINE_CHAT_MIN_HEIGHT = 160
const VOICE_STAGE_HEADER_ICON_CLASS =
  'text-white/70 hover:bg-white/10 hover:text-white'
const VOICE_STAGE_HEADER_SEARCH_STRIP_CLASS =
  'border-white/20 bg-white/10 text-white/70 hover:bg-white/15 hover:text-white'

export function clampInlineVoiceStageHeight(
  height: number,
  containerHeight: number,
) {
  const maxHeight = Math.max(
    INLINE_VOICE_STAGE_MIN_HEIGHT,
    containerHeight - INLINE_CHAT_MIN_HEIGHT,
  )

  return Math.min(
    Math.max(INLINE_VOICE_STAGE_MIN_HEIGHT, height),
    maxHeight,
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
  const navigate = useNavigate()
  const routePrefix = useAppRoutePrefix()
  const isMobileRoute = routePrefix === '/m'
  const voice = useVoiceSession()
  const chat = useChannelChat({ channelId, highlightMessageId })
  const [dmProfilePanelOpen, setDmProfilePanelOpen] = useState(true)
  const [dmProfilePanelWidth, setDmProfilePanelWidth] = useState(320)
  const [dmProfilePanelResizing, setDmProfilePanelResizing] = useState(false)
  const [fullProfileOpen, setFullProfileOpen] = useState(false)
  const [inlineVoiceStageHeight, setInlineVoiceStageHeight] = useState(
    INLINE_VOICE_STAGE_DEFAULT_HEIGHT,
  )
  const observedChannelRef = useRef(false)
  const channelContentRef = useRef<HTMLDivElement>(null)
  const inlineVoiceStageRef = useRef<HTMLElement>(null)

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
  const syncReady = useSyncStore((state) => state.ready)

  useEffect(() => {
    if (channel) {
      observedChannelRef.current = true
      return
    }
    if (!syncReady || !observedChannelRef.current) return

    void navigate({
      to: routePrefix,
      search: { tab: 'online' },
      replace: true,
    })
  }, [channel, navigate, routePrefix, syncReady])

  useEffect(() => {
    setDmProfilePanelOpen(true)
    setFullProfileOpen(false)
    setInlineVoiceStageHeight(INLINE_VOICE_STAGE_DEFAULT_HEIGHT)
  }, [channelId])

  useEffect(() => {
    const container = channelContentRef.current
    if (!container) return

    const syncHeightToContainer = () => {
      setInlineVoiceStageHeight((current) =>
        clampInlineVoiceStageHeight(current, container.clientHeight),
      )
    }

    syncHeightToContainer()
    const observer = new ResizeObserver(syncHeightToContainer)
    observer.observe(container)
    return () => observer.disconnect()
  }, [channelId])

  const currentUserId = auth.user?._id
  const voiceCall = useSyncStore((s) => s.voiceCalls[channelId])
  const voiceCallRingingDismissed = useSyncStore((s) =>
    isVoiceCallRingingDismissed(voiceCall, s.dismissedVoiceCallKeys),
  )
  const dmRecipientId = channel
    ? getDmRecipientId(channel, currentUserId)
    : undefined
  const dmAliases = useSyncStore((s) =>
    dmRecipientId
      ? listUserMutualServerNicknames(s, dmRecipientId, currentUserId)
      : EMPTY_ALIASES,
  )
  const isDirectMessage = channel?.channel_type === 'DirectMessage'
  const isGroupDirectMessage = channel?.channel_type === 'Group'
  const isDmVoiceCallChannel =
    channel?.channel_type === 'DirectMessage' || channel?.channel_type === 'Group'
  const hasBotRecipient =
    isDmVoiceCallChannel && channel
      ? channel.recipients.some((recipientId) =>
          Boolean(users[recipientId]?.bot),
        )
      : false
  const hasVoice = Boolean(channel && channelHasVoice(channel) && !hasBotRecipient)
  const inThisVoiceSession =
    voice.channelId === channelId &&
    (voice.status === 'connected' || voice.status === 'connecting')
  const showInlineVoiceStage =
    hasVoice &&
    isDmVoiceCallChannel &&
    (inThisVoiceSession || hasOngoingVoiceCall(voiceCall))
  const dmInCallLayout = Boolean(isDirectMessage && showInlineVoiceStage)

  useEffect(() => {
    if (dmInCallLayout) {
      setDmProfilePanelOpen(false)
    }
  }, [dmInCallLayout])

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
  const dmRecipient = dmRecipientId ? users[dmRecipientId] : undefined
  const dmMessagesBlocked =
    Boolean(dmRecipient && !canMessageUser(dmRecipient._id))
  const dmDisabledPlaceholder =
    dmRecipient?.relationship === 'Blocked'
      ? 'Вы заблокировали этого пользователя'
      : dmRecipient?.relationship === 'BlockedOther'
        ? 'Пользователь заблокировал вас'
        : undefined
  const inThisVoiceCall =
    voice.channelId === channelId &&
    voice.status === 'connected'
  const voiceCallIncoming = isIncomingVoiceCall(voiceCall, currentUserId)
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
  const voiceCallInitiatedByCurrentUser =
    Boolean(currentUserId) && voiceCall?.initiatorId === currentUserId
  function dismissVoiceCallBanner() {
    if (!voiceCall) return

    if (isDirectMessage && voiceCall.phase === 'ringing') {
      if (!token || !currentUserId) return

      const updateCall = voiceCallInitiatedByCurrentUser
        ? cancelDirectMessageCall(token, channelId)
        : declineDirectMessageCall(token, channelId)

      void updateCall
        .then(() => {
          if (voiceCallInitiatedByCurrentUser) {
            syncStore.removeVoiceCall(channelId)
          } else {
            syncStore.markVoiceCallDeclined(channelId, currentUserId)
          }
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

    const container = channelContentRef.current
    const section = inlineVoiceStageRef.current
    if (!container || !section) return

    const startY = event.clientY
    const startHeight = section.getBoundingClientRect().height
    const containerHeight = container.clientHeight

    function handlePointerMove(moveEvent: PointerEvent) {
      setInlineVoiceStageHeight(
        clampInlineVoiceStageHeight(
          startHeight + moveEvent.clientY - startY,
          containerHeight,
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

  function handleMobileBack() {
    if (isServerChannel && serverIdForSelection) {
      syncStore.setSelectedServerId(serverIdForSelection)
    } else {
      syncStore.setSelectedServerId(null)
    }
    void navigate({
      to: '/m',
      search: { tab: 'online' },
    })
  }

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      {!dmInCallLayout ? (
        <header
          className={cn(shellColumnHeaderClass, shellChromeSurface, 'px-0')}
        >
        <div
          className={cn(
            'flex min-w-0 flex-1 items-center gap-2',
            isMobileRoute ? 'pl-2' : 'pl-4',
          )}
        >
          {isMobileRoute ? (
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="size-8 shrink-0"
              aria-label="Назад"
              title="Назад"
              onClick={handleMobileBack}
            >
              <ChevronLeftIcon className="size-5" />
            </Button>
          ) : null}
          {isDirectMessage && dmRecipient ? (
            <DirectMessageHeader
              user={dmRecipient}
              title={title}
              aliases={dmAliases}
              onOpenProfile={() => setFullProfileOpen(true)}
            />
          ) : isGroupDirectMessage ? (
            <div className="flex min-w-0 flex-1 items-center gap-2">
              {channel.icon ? (
                <img
                  src={attachmentPreviewUrl(channel.icon)}
                  alt=""
                  className="size-7 shrink-0 rounded-md object-cover"
                />
              ) : (
                <span
                  title="Групповой чат"
                  className="flex size-5 shrink-0 items-center justify-center text-muted-foreground"
                >
                  <UsersIcon aria-hidden="true" className="size-5" />
                </span>
              )}
              <h1 className="truncate font-semibold">{title}</h1>
            </div>
          ) : (
            <div className="min-w-0 flex-1">
              <h1 className="truncate font-semibold">{title}</h1>
            </div>
          )}
          {historyQuery.isFetching ? (
            <span className="text-xs text-muted-foreground">загрузка…</span>
          ) : null}
          {isDirectMessage && dmRecipient ? (
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="size-8"
              aria-pressed={dmProfilePanelOpen}
              aria-label={
                dmProfilePanelOpen ? 'Скрыть профиль' : 'Показать профиль'
              }
              title={dmProfilePanelOpen ? 'Скрыть профиль' : 'Показать профиль'}
              onClick={() => setDmProfilePanelOpen((open) => !open)}
            >
              <UserIcon className="size-4" />
            </Button>
          ) : null}
          {channel.channel_type === 'Group' ? (
            <GroupManagementDialog channel={channel} />
          ) : null}
          {hasVoice && !inThisVoiceSession ? (
            <>
              {voiceCallIncoming &&
              voiceCall?.phase === 'ringing' &&
              isDirectMessage ? (
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  onClick={dismissVoiceCallBanner}
                >
                  {voiceCallInitiatedByCurrentUser ? 'Отменить' : 'Отклонить'}
                </Button>
              ) : null}
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="size-8"
                aria-label={voiceActionLabel}
                title={voiceActionLabel}
                onClick={() => void voice.join(channelId)}
              >
                {isDmVoiceCallChannel ? (
                  <PhoneIcon className="size-4" />
                ) : (
                  <HeadphonesIcon className="size-4" />
                )}
              </Button>
            </>
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
            <div className="lg:hidden">
              <ChannelSearchDialog
                channelId={channelId}
                token={token}
                users={users}
                variant="icon"
              />
            </div>
          ) : null}
        </div>
        {token && showMemberSidebar ? (
          <div className="hidden h-full w-52 shrink-0 items-center pl-2 lg:flex">
            <ServerChannelSearchPopover
              serverId={channel.server}
              token={token}
              users={users}
            />
          </div>
        ) : null}
        {token && !showMemberSidebar ? (
          <div className="hidden h-full w-52 shrink-0 items-center pl-2 lg:flex">
            <ChannelSearchDialog
              channelId={channelId}
              token={token}
              users={users}
              variant="strip"
            />
          </div>
        ) : null}
      </header>
      ) : null}

      <div className="flex min-h-0 min-w-0 flex-1">
        <div
          ref={channelContentRef}
          data-channel-content
          className="relative flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden"
        >
          {showInlineVoiceStage &&
          (channel.channel_type === 'DirectMessage' ||
            channel.channel_type === 'Group') ? (
            <section
              ref={inlineVoiceStageRef}
              aria-label="Голосовой звонок"
              className="relative flex min-h-0 min-w-0 shrink-0 flex-col overflow-hidden border-b border-shell-divider bg-black"
              style={{
                height: inlineVoiceStageHeight,
                minHeight: INLINE_VOICE_STAGE_MIN_HEIGHT,
              }}
            >
              <VoiceStageView
                channel={channel}
                title={title}
                chatOpen={false}
                onToggleChat={() => undefined}
                showChatToggle={false}
                voiceCall={voiceCall}
                voiceCallIncoming={voiceCallIncoming}
                onDeclineVoiceCall={
                  voiceCallIncoming && voiceCall?.phase === 'ringing'
                    ? dismissVoiceCallBanner
                    : undefined
                }
                dmHeader={
                  dmInCallLayout && dmRecipient
                    ? {
                        user: dmRecipient,
                        aliases: dmAliases,
                        onOpenProfile: () => setFullProfileOpen(true),
                        loading: historyQuery.isFetching,
                      }
                    : undefined
                }
                headerTrailing={
                  dmInCallLayout && token ? (
                    <>
                      <ChannelPinnedDialog
                        channelId={channelId}
                        token={token}
                        users={users}
                        triggerClassName={VOICE_STAGE_HEADER_ICON_CLASS}
                      />
                      <div className="lg:hidden">
                        <ChannelSearchDialog
                          channelId={channelId}
                          token={token}
                          users={users}
                          variant="icon"
                          triggerClassName={VOICE_STAGE_HEADER_ICON_CLASS}
                        />
                      </div>
                      <div className="hidden w-52 lg:flex">
                        <ChannelSearchDialog
                          channelId={channelId}
                          token={token}
                          users={users}
                          variant="strip"
                          stripClassName={VOICE_STAGE_HEADER_SEARCH_STRIP_CLASS}
                        />
                      </div>
                    </>
                  ) : undefined
                }
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
                  ? voiceCallInitiatedByCurrentUser
                    ? 'Отменить'
                    : 'Отклонить'
                  : 'Скрыть'
              }
              onJoin={() => {
                void voice.join(channelId)
              }}
              onDismiss={dismissVoiceCallBanner}
            />
          ) : null}
          <div className="relative flex min-h-0 flex-1 flex-col">
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
              onReply={(message) =>
                setComposerAction({ type: 'reply', message })
              }
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
                'pointer-events-none absolute z-20 flex flex-col items-stretch gap-1 transition-[right] duration-200 ease-[cubic-bezier(0.22,1,0.36,1)] motion-reduce:transition-none',
                FLOATING_BAR_INSET_X_CLASS,
                FLOATING_BAR_BOTTOM_CLASS,
                dmProfilePanelResizing && 'transition-none',
              )}
              style={{
                right:
                  isDirectMessage && dmProfilePanelOpen && !dmInCallLayout
                    ? dmProfilePanelWidth + 8
                    : 8,
              }}
            >
              <TypingIndicator channelId={channelId} floating />
              <MessageComposer
                channel={channel}
                users={users}
                floating
                disabled={
                  !token || auth.gatewayState !== 'connected' || dmMessagesBlocked
                }
                disabledPlaceholder={dmDisabledPlaceholder}
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
        {isDirectMessage && dmRecipient && !dmInCallLayout ? (
          <DirectMessageProfilePanel
            user={dmRecipient}
            currentUserId={auth.user?._id}
            token={token}
            aliases={dmAliases}
            open={dmProfilePanelOpen}
            onWidthChange={setDmProfilePanelWidth}
            onResizingChange={setDmProfilePanelResizing}
            onOpenProfile={() => setFullProfileOpen(true)}
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
