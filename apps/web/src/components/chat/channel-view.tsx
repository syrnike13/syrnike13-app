import {
  useEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from 'react'
import { useNavigate } from '@tanstack/react-router'
import { Effect } from 'effect'
import {
  ChevronLeftIcon,
  HashIcon,
  HeadphonesIcon,
  PhoneIcon,
  UserIcon,
  UsersIcon,
} from '#/components/icons'

import { VoiceChannelShell } from '#/components/voice/voice-channel-shell'
import { VoiceStageView } from '#/components/voice/voice-stage-view'
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
import { ChannelSettingsDialog } from '#/components/channels/channel-settings-dialog'
import { ChannelMemberSidebar } from '#/components/chat/channel-member-sidebar'
import { DirectMessageProfilePanel } from '#/components/chat/direct-message-profile-panel'
import { GroupMemberSidebar } from '#/components/chat/group-member-sidebar'
import { GroupManagementDialog } from '#/components/chat/group-management-dialog'
import { VoiceCallBanner } from '#/components/voice/voice-call-banner'
import { ChannelPinnedDialog } from '#/components/chat/channel-pinned-dialog'
import { MessageSearch, type MessageSearchScope } from '#/components/chat/message-search'
import { ChannelIntro } from '#/components/chat/channel-intro'
import { MessageComposer } from '#/components/chat/message-composer'
import {
  MessageList,
  type MessageListHandle,
} from '#/components/chat/message-list'
import { TypingIndicator } from '#/components/chat/typing-indicator'
import { UserAvatar } from '#/components/user/user-avatar'
import { UserGlobalProfileDialog } from '#/components/user/user-global-profile-dialog'
import { useChannelChat } from '#/features/chat/use-channel-chat'
import { useAppRoutePrefix } from '#/features/navigation/route-prefix'
import { getChannelLabel, getDmRecipientId } from '#/features/sync/channel-label'
import { useVoiceSession } from '#/features/voice/voice-session-context'
import {
  FLOATING_BAR_BOTTOM_CLASS,
  FLOATING_BAR_BOTTOM_OFFSET_PX,
  FLOATING_BAR_INSET_X_CLASS,
  shellChromeSurface,
  shellColumnHeaderClass,
} from '#/components/layout/shell-chrome'
import type { CSSVars } from '#/lib/css-vars'
import { cn } from '#/lib/utils'
import { attachmentPreviewUrl } from '#/lib/media'
import { VoiceTextChannelDock } from '#/components/voice/voice-text-channel-dock'
import { channelHasVoice, isServerVoiceChannel } from '#/lib/channel-voice'
import { canMessageUser } from '#/features/authorization/authorization'
import { blockUserRelationship } from '#/features/friends/friend-actions'
import { closeVoiceCallNotification } from '#/features/notifications/voice-call-notifications'
import {
  editChannelMessageEffect,
  reactToMessageEffect,
  sendChannelMessageEffect,
  unreactFromMessageEffect,
} from '#/features/api/messages-api'
import {
  cancelDirectMessageCallEffect,
  declineDirectMessageCallEffect,
} from '#/features/api/channels-api'
import { listUserMutualServerNicknames } from '#/features/sync/selectors'
import { syncStore, useSyncStore } from '#/features/sync/sync-store'
import {
  hasOngoingVoiceCall,
  isIncomingVoiceCall,
  isVoiceCallRingingDismissed,
} from '#/features/sync/voice-call-utils'
import { useTranslations } from '@syrnike13/ui/i18n'

type ChannelViewProps = {
  channelId: string
  highlightMessageId?: string
}

const EMPTY_ALIASES: string[] = []
const INLINE_VOICE_STAGE_DEFAULT_HEIGHT = 360
const INLINE_VOICE_STAGE_MIN_HEIGHT = 220
const INLINE_CHAT_MIN_HEIGHT = 160
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

export function ChannelView({
  channelId,
  highlightMessageId,
}: ChannelViewProps) {
  const t = useTranslations('chat')
  const tVoice = useTranslations('chat.voice')
  const tu = useTranslations('users')
  const navigate = useNavigate()
  const routePrefix = useAppRoutePrefix()
  const isMobileRoute = routePrefix === '/m'
  const voice = useVoiceSession()
  const chat = useChannelChat({ channelId, highlightMessageId })
  const [dmProfilePanelOpen, setDmProfilePanelOpen] = useState(true)
  const [membersVisible, setMembersVisible] = useState(true)
  const [fullProfileOpen, setFullProfileOpen] = useState(false)
  const [blockUserId, setBlockUserId] = useState<string | null>(null)
  const messageListRef = useRef<MessageListHandle>(null)
  const [inlineVoiceStageHeight, setInlineVoiceStageHeight] = useState(
    INLINE_VOICE_STAGE_DEFAULT_HEIGHT,
  )
  const [composerHeight, setComposerHeight] = useState(56)
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
    jumpMessageId,
    editLastOwnMessage,
    notifyTyping,
    stopTyping,
  } = chat
  const syncReady = useSyncStore((state) => state.ready)

  useEffect(() => {
    if (channel) {
      observedChannelRef.current = true
      return
    }
    if (!syncReady || !observedChannelRef.current) return

    void navigate({
      to: routePrefix || '/',
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
        {t('channelNotFound')}
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

  const title = getChannelLabel(channel, users, auth.user?._id, t)
  const dmRecipient = dmRecipientId ? users[dmRecipientId] : undefined
  const dmMessagesBlocked =
    Boolean(dmRecipient && !canMessageUser(dmRecipient._id))
  const dmDisabledPlaceholder =
    dmRecipient?.relationship === 'Blocked'
      ? t('blockedByYou')
      : dmMessagesBlocked
        ? t('cannotSend')
        : undefined
  const inThisVoiceCall =
    voice.channelId === channelId &&
    voice.status === 'connected'
  const voiceCallIncoming = isIncomingVoiceCall(voiceCall, currentUserId)
  let voiceActionLabel = isDmVoiceCallChannel ? tVoice('call') : tVoice('voice')
  if (
    (isDmVoiceCallChannel && voiceCall?.phase === 'active') ||
    (isGroupDirectMessage && voiceCall)
  ) {
    voiceActionLabel = tVoice('join')
  } else if (
    isDmVoiceCallChannel &&
    !voiceCallRingingDismissed &&
    voiceCallIncoming
  ) {
    voiceActionLabel = tVoice('answer')
  }
  const showVoiceCallBanner =
    Boolean(voiceCall) &&
    !inThisVoiceSession &&
    !showInlineVoiceStage &&
    !voiceCallRingingDismissed &&
    voiceCallIncoming
  const showMemberSidebar =
    isServerChannel && channel.channel_type === 'TextChannel'
  const showMembersToggle = showMemberSidebar || channel.channel_type === 'Group'
  const searchScope: MessageSearchScope =
    channel.channel_type === 'TextChannel'
      ? { kind: 'server', serverId: channel.server }
      : { kind: 'channel', channelId }
  const voiceCallInitiator = voiceCall ? users[voiceCall.initiatorId] : undefined
  const voiceCallInitiatorName =
    voiceCallInitiator?.display_name ??
    voiceCallInitiator?.username ??
    t('system.user')
  const voiceCallInitiatedByCurrentUser =
    Boolean(currentUserId) && voiceCall?.initiatorId === currentUserId
  function dismissVoiceCallBanner() {
    if (!voiceCall) return

    if (isDirectMessage && voiceCall.phase === 'ringing') {
      if (!token || !currentUserId) return

      Effect.runFork(
        (
          voiceCallInitiatedByCurrentUser
            ? cancelDirectMessageCallEffect(token, channelId)
            : declineDirectMessageCallEffect(token, channelId)
        ).pipe(
          Effect.andThen(
            Effect.sync(() => {
              if (voiceCallInitiatedByCurrentUser) {
                syncStore.removeVoiceCall(channelId)
              } else {
                syncStore.markVoiceCallDeclined(channelId, currentUserId)
              }
            }),
          ),
          Effect.andThen(closeVoiceCallNotification(channelId)),
          Effect.ignore,
        ),
      )
      return
    }

    syncStore.dismissVoiceCall(voiceCall)
    Effect.runFork(closeVoiceCallNotification(channelId))
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
          className={cn(
            shellColumnHeaderClass,
            shellChromeSurface,
            isMobileRoute ? 'px-2' : 'pr-2 pl-4',
          )}
        >
          {isMobileRoute ? (
            <Button
              type="button"
              variant="ghost"
              size="icon"
              aria-label={tVoice('back')}
              title={tVoice('back')}
              onClick={handleMobileBack}
            >
              <ChevronLeftIcon className="size-5" />
            </Button>
          ) : null}
          <div className="flex min-w-0 flex-1 items-center gap-2">
            {isDirectMessage && dmRecipient ? (
              <UserAvatar
                user={dmRecipient}
                className="size-6"
                fallbackClassName="size-6 text-xs"
                showPresence
              />
            ) : channel.channel_type === 'Group' ? (
              channel.icon ? (
                <img
                  src={attachmentPreviewUrl(channel.icon)}
                  alt=""
                  className="size-6 shrink-0 rounded-full object-cover"
                />
              ) : (
                <UsersIcon aria-hidden="true" className="size-5 shrink-0 text-muted-foreground" />
              )
            ) : (
              <HashIcon aria-hidden="true" className="size-5 shrink-0 text-muted-foreground" />
            )}
            <h1 className="truncate text-base leading-5 font-semibold">{title}</h1>
          </div>
          <div className="flex shrink-0 items-center gap-1 text-muted-foreground">
            {hasVoice && !inThisVoiceSession ? (
              <>
                {voiceCallIncoming && voiceCall?.phase === 'ringing' && isDirectMessage ? (
                  <Button type="button" size="sm" variant="ghost" onClick={dismissVoiceCallBanner}>
                    {voiceCallInitiatedByCurrentUser ? tVoice('cancel') : tVoice('decline')}
                  </Button>
                ) : null}
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  aria-label={voiceActionLabel}
                  title={voiceActionLabel}
                  onClick={() => void voice.join(channelId)}
                >
                  {isDmVoiceCallChannel ? (
                    <PhoneIcon className="size-5" />
                  ) : (
                    <HeadphonesIcon className="size-5" />
                  )}
                </Button>
              </>
            ) : null}
            {token ? <ChannelPinnedDialog channelId={channelId} token={token} users={users} /> : null}
            {channel.channel_type === 'Group' ? <GroupManagementDialog channel={channel} /> : null}
            {channel.channel_type === 'TextChannel' ? <ChannelSettingsDialog channel={channel} /> : null}
            {isDirectMessage && dmRecipient ? (
              <Button
                type="button"
                variant="ghost"
                size="icon"
                aria-pressed={dmProfilePanelOpen}
                aria-label={dmProfilePanelOpen ? tVoice('hideProfile') : tVoice('showProfile')}
                title={dmProfilePanelOpen ? tVoice('hideProfile') : tVoice('showProfile')}
                onClick={() => setDmProfilePanelOpen((open) => !open)}
              >
                <UserIcon className="size-5" />
              </Button>
            ) : null}
            {showMembersToggle ? (
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="hidden lg:inline-flex"
                aria-pressed={membersVisible}
                aria-label={membersVisible ? t('hideMembers') : t('showMembers')}
                title={membersVisible ? t('hideMembers') : t('showMembers')}
                onClick={() => setMembersVisible((visible) => !visible)}
              >
                <UsersIcon className="size-5" />
              </Button>
            ) : null}
            {token ? (
              <>
                <div className="ml-1 hidden w-60 lg:block">
                  <MessageSearch scope={searchScope} token={token} users={users} />
                </div>
                <div className="lg:hidden">
                  <MessageSearch scope={searchScope} token={token} users={users} variant="icon" />
                </div>
              </>
            ) : null}
          </div>
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
              aria-label={tVoice('callAria')}
              className="relative flex h-(--inline-voice-height) min-h-(--inline-voice-min-height) min-w-0 shrink-0 flex-col overflow-hidden border-b border-shell-divider bg-media-backdrop"
              style={
                {
                  '--inline-voice-height': `${inlineVoiceStageHeight}px`,
                  '--inline-voice-min-height': `${INLINE_VOICE_STAGE_MIN_HEIGHT}px`,
                } as CSSVars
              }
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
                        triggerVariant="media"
                      />
                      <MessageSearch
                        scope={searchScope}
                        token={token}
                        users={users}
                        variant="icon"
                        triggerVariant="media"
                      />
                    </>
                  ) : undefined
                }
              />
              {/* eslint-disable-next-line design/no-lookalike -- resize handle (role=separator) of the inline voice stage */}
              <div
                aria-label={tVoice('resizeAria')}
                aria-orientation="horizontal"
                className="absolute inset-x-0 bottom-0 z-70 h-2 cursor-row-resize touch-none bg-transparent transition-colors hover:bg-on-media/20"
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
              title={isDirectMessage ? tVoice('dmCall') : tVoice('groupCall')}
              detail={
                voiceCall.phase === 'ringing'
                  ? tVoice('calling', { name: voiceCallInitiatorName })
                  : tVoice('ongoing')
              }
              actionLabel={tVoice('answer')}
              dismissLabel={
                isDirectMessage && voiceCall.phase === 'ringing'
                  ? voiceCallInitiatedByCurrentUser
                    ? tVoice('cancel')
                    : tVoice('decline')
                  : tVoice('hide')
              }
              onJoin={() => {
                void voice.join(channelId)
              }}
              onDismiss={dismissVoiceCallBanner}
            />
          ) : null}
          <div
            className="relative flex min-h-0 flex-1 flex-col pb-(--chat-feed-inset)"
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
              onReply={(message) =>
                setComposerAction({ type: 'reply', message })
              }
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
          </div>
          {isDirectMessage && dmRecipient && !dmInCallLayout ? (
            <DirectMessageProfilePanel
              open={dmProfilePanelOpen}
              user={dmRecipient}
              currentUserId={auth.user?._id}
              token={token}
              aliases={dmAliases}
              onOpenProfile={() => setFullProfileOpen(true)}
            />
          ) : null}
          {channel.channel_type === 'Group' && membersVisible ? (
            <GroupMemberSidebar channel={channel} />
          ) : null}
          {showMemberSidebar && membersVisible ? (
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
                  blockUserRelationship(token, userId).pipe(Effect.ignore),
                )
              }}
            >
              {t('block')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
