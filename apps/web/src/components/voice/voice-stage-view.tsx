import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
  type Ref,
} from 'react'
import { MessageSquareIcon, ChevronDownIcon } from '#/components/icons'
import { VoiceChannelIcon } from '#/components/icons/voice-channel-icon'
import type { Channel, User } from '@syrnike13/api-types'
import type {
  UserVoiceState,
  VoiceCallState,
} from '#/features/sync/voice-types'
import { toast } from 'sonner'

import { Button } from '#/components/ui/button'
import { UserAvatar } from '#/components/user/user-avatar'
import { VoiceOnAirBadge } from '#/components/voice/voice-participant-icons'
import { VoiceStageFocusStage } from '#/components/voice/voice-stage-focus-stage'
import { StageMediaTile } from '#/components/voice/voice-stage-media-tile'
import { VoiceStageStreamVolumeControl } from '#/components/voice/voice-stage-stream-volume-control'
import {
  VoiceStageControls,
  VoiceStageFullscreenButton,
  VoiceStagePopoutButton,
} from '#/components/voice/voice-stage-controls'
import { VoiceStageAvatarRoster } from '#/components/voice/voice-stage-avatar-roster'
import { VoiceStageInviteTile } from '#/components/voice/voice-stage-tile'
import { VoiceStagePopout } from '#/components/voice/voice-stage-popout'
import { VoiceStagePopoutPlaceholder } from '#/components/voice/voice-stage-popout-placeholder'
import { useAuth } from '#/features/auth/auth-context'
import {
  getChannelVoiceParticipants,
  useChannelVoiceParticipantsWithLocalOverride,
} from '#/features/sync/voice-selectors'
import { useSyncStore } from '#/features/sync/sync-store'
import {
  nextStageLayoutModeForMediaClick,
  resolveStageLayoutMode,
  type VoiceStageLayoutMode,
} from '#/features/voice/voice-stage-mode'
import type { VoiceStageMediaItem } from '#/features/voice/voice-context'
import { useVoiceSession } from '#/features/voice/voice-session-context'
import { useVoiceStage } from '#/features/voice/voice-stage-context'
import { isVoiceSessionInChannel } from '#/features/voice/voice-mic-status'
import {
  filterStageVideoMediaItems,
  sortStageMediaItemsForGrid,
  stageMediaKindLabel,
} from '#/features/voice/voice-stage-media'
import {
  shouldShowVoiceInviteSlot,
  voiceStageContentInsetClass,
  voiceStageControlsChromeCenterClass,
  voiceStageControlsChromeClass,
  voiceStageControlsChromeTrailingClass,
} from '#/components/voice/voice-stage-layout'
import { VoiceStageGrid } from '#/components/voice/voice-stage-grid'
import {
  useVoiceStageChromeVisible,
  voiceStageChromeMotion,
} from '#/features/voice/use-voice-stage-chrome-visible'
import { voiceParticipantDisplayName } from '#/features/voice/voice-participant-label'
import { isVoiceLocalUserId } from '#/features/voice/voice-connecting-preview'
import { canInviteToChannel } from '#/features/authorization/authorization'
import { cn } from '#/lib/utils'

type VoiceStageDmHeader = {
  user: User
  aliases: string[]
  onOpenProfile?: () => void
  loading?: boolean
}

type VoiceStageViewProps = {
  channel: Channel
  title: string
  chatOpen: boolean
  onToggleChat: () => void
  showChatToggle?: boolean
  /** Встроен в мобильный drawer — без popout/fullscreen. */
  mobileDrawer?: boolean
  onClose?: () => void
  joinButtonLabel?: string
  voiceCall?: VoiceCallState
  voiceCallIncoming?: boolean
  onDeclineVoiceCall?: () => void
  dmHeader?: VoiceStageDmHeader
  headerTrailing?: ReactNode
}

const STAGE_POPOUT_WINDOW_NAME = 'syrnike13-voice-stage'
const EMPTY_STAGE_MEDIA_ITEMS: readonly VoiceStageMediaItem[] = []

export function VoiceStageView({
  channel,
  title,
  chatOpen,
  onToggleChat,
  showChatToggle = true,
  mobileDrawer = false,
  onClose,
  joinButtonLabel,
  voiceCall,
  voiceCallIncoming = false,
  onDeclineVoiceCall,
  dmHeader,
  headerTrailing,
}: VoiceStageViewProps) {
  const auth = useAuth()
  const voiceSession = useVoiceSession()
  const voiceStage = useVoiceStage()
  const channelId = channel._id
  const users = useSyncStore((s) => s.users)
  const server = useSyncStore((s) =>
    channel.channel_type === 'TextChannel'
      ? s.servers[channel.server]
      : undefined,
  )
  const member = useSyncStore((s) =>
    channel.channel_type === 'TextChannel' && auth.user?._id
      ? s.members[`${channel.server}:${auth.user._id}`]
      : undefined,
  )
  const storeParticipants = useSyncStore((s) =>
    getChannelVoiceParticipants(s, channelId, auth.user?._id),
  )
  const inVoiceSession = isVoiceSessionInChannel(voiceSession, channelId)
  const inThisVoiceCall = voiceSession.status === 'connected' && inVoiceSession
  const connecting = voiceSession.status === 'connecting' && inVoiceSession
  const isDmVoiceStage =
    channel.channel_type === 'DirectMessage' || channel.channel_type === 'Group'
  const resolvedJoinLabel =
    joinButtonLabel ?? (isDmVoiceStage ? 'Присоединиться' : undefined)
  const [requestedMode, setRequestedMode] =
    useState<VoiceStageLayoutMode>('grid')
  const [popoutWindow, setPopoutWindow] = useState<Window | null>(null)
  const popoutWindowRef = useRef<Window | null>(null)
  const popoutOpen = popoutWindow != null && !popoutWindow.closed
  const { stageRef, chromeVisible } = useVoiceStageChromeVisible(
    popoutOpen ? 'popout' : 'embedded',
  )

  useEffect(() => {
    popoutWindowRef.current = popoutWindow
  }, [popoutWindow])

  useEffect(() => {
    if (!popoutWindow) return

    const handlePopoutClosed = () => {
      setPopoutWindow((current) => (current === popoutWindow ? null : current))
    }

    popoutWindow.addEventListener('beforeunload', handlePopoutClosed)
    popoutWindow.addEventListener('unload', handlePopoutClosed)

    return () => {
      popoutWindow.removeEventListener('beforeunload', handlePopoutClosed)
      popoutWindow.removeEventListener('unload', handlePopoutClosed)
    }
  }, [popoutWindow])

  useEffect(() => {
    return () => {
      const current = popoutWindowRef.current
      if (current && !current.closed) {
        current.close()
      }
    }
  }, [])

  const participants = useChannelVoiceParticipantsWithLocalOverride(
    channelId,
    storeParticipants,
    inVoiceSession ? auth.user?._id : undefined,
    inVoiceSession ? voiceSession.micPublishing : undefined,
    inVoiceSession ? voiceSession.deafened : undefined,
  )
  const participantsById = useMemo(
    () => new Map(participants.map((participant) => [participant.id, participant])),
    [participants],
  )
  const mediaItems =
    voiceStage.stageChannelId === channelId
      ? voiceStage.stageMediaItems
      : EMPTY_STAGE_MEDIA_ITEMS
  const gridMediaItems = useMemo(
    () => sortStageMediaItemsForGrid(mediaItems),
    [mediaItems],
  )
  const videoMediaItems = useMemo(
    () => filterStageVideoMediaItems(gridMediaItems),
    [gridMediaItems],
  )
  const mediaIds = useMemo(() => mediaItems.map((item) => item.id), [mediaItems])
  const videoUserIds = useMemo(
    () => new Set(videoMediaItems.map((item) => item.userId)),
    [videoMediaItems],
  )
  const avatarOnlyParticipants = useMemo(
    () => participants.filter((participant) => !videoUserIds.has(participant.id)),
    [participants, videoUserIds],
  )
  const useAvatarRosterLayout =
    videoMediaItems.length === 0 &&
    gridMediaItems.length === 0 &&
    participants.length > 0

  useEffect(() => {
    if (!voiceStage.stageFocusNonce) return
    const mediaId = voiceStage.focusedMediaId
    if (!mediaId || !mediaIds.includes(mediaId)) return
    setRequestedMode('focus')
  }, [mediaIds, voiceStage.focusedMediaId, voiceStage.stageFocusNonce])

  const layoutMode = resolveStageLayoutMode({
    requestedMode,
    focusedMediaId: voiceStage.focusedMediaId,
    visibleMediaIds: mediaIds,
  })
  const focusedItem =
    layoutMode === 'focus'
      ? mediaItems.find((item) => item.id === voiceStage.focusedMediaId) ?? null
      : null
  const focusedMediaHeader = useMemo(() => {
    if (!focusedItem) return null
    const kindLabel = stageMediaKindLabel(focusedItem.kind)
    if (!kindLabel) return null

    const isLocal = isVoiceLocalUserId(
      focusedItem.userId,
      auth.user?._id ?? null,
    )
    const user =
      users[focusedItem.userId] ?? (isLocal ? auth.user ?? undefined : undefined)
    const participant = participantsById.get(focusedItem.userId)

    return {
      user,
      kindLabel,
      displayName: voiceParticipantDisplayName(
        focusedItem.userId,
        users,
        auth.user,
      ),
      showOnAir:
        focusedItem.kind === 'screen' && Boolean(participant?.screensharing),
    }
  }, [auth.user, focusedItem, participantsById, users])
  const canToggleStageFullscreen =
    !mobileDrawer && (participants.length > 0 || mediaItems.length > 0)
  const canInvite =
    server && channel.channel_type === 'TextChannel'
      ? canInviteToChannel(
          server,
          channel,
          member,
          auth.user?._id,
        )
      : false
  const showInviteSlot =
    canInvite &&
    layoutMode === 'grid' &&
    !voiceStage.stageFullscreen &&
    shouldShowVoiceInviteSlot(participants.length)
  const showEmptyStage =
    participants.length === 0 &&
    mediaItems.length === 0 &&
    !(isDmVoiceStage && voiceCall)
  const showRemoteJoinPreview =
    useAvatarRosterLayout &&
    !inThisVoiceCall &&
    !connecting &&
    !isDmVoiceStage
  const showCenteredJoin =
    !inThisVoiceCall &&
    !connecting &&
    (showEmptyStage || showRemoteJoinPreview)

  const focusMedia = useCallback(
    (mediaId: string) => {
      const next = nextStageLayoutModeForMediaClick({
        clickedMediaId: mediaId,
        currentMode: layoutMode,
        focusedMediaId: voiceStage.focusedMediaId,
      })
      voiceStage.setFocusedMediaId(next.focusedMediaId)
      setRequestedMode(next.mode)
    },
    [layoutMode, voiceStage],
  )

  useEffect(() => {
    if (!voiceStage.stageFullscreen) return

    function onKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        voiceStage.toggleStageFullscreen()
      }
    }

    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [voiceStage])

  const closePopout = useCallback(() => {
    const win = popoutWindowRef.current
    setPopoutWindow(null)
    if (win && !win.closed) {
      try {
        win.close()
      } catch {
        // окно уже закрыто
      }
    }
  }, [])

  const toggleStagePopout = useCallback(() => {
    if (popoutOpen && popoutWindow) {
      closePopout()
      return
    }
    if (!canToggleStageFullscreen) return

    if (voiceStage.stageFullscreen) {
      voiceStage.toggleStageFullscreen()
    }

    const childWindow = window.open(
      '',
      STAGE_POPOUT_WINDOW_NAME,
      'popup=yes,width=1280,height=720',
    )
    if (!childWindow) {
      toast.error('Браузер заблокировал отдельное окно стейджа')
      return
    }

    setPopoutWindow((current) => {
      if (current && current !== childWindow && !current.closed) {
        current.close()
      }
      return childWindow
    })
    childWindow.focus()
  }, [
    canToggleStageFullscreen,
    closePopout,
    popoutOpen,
    popoutWindow,
    voiceStage,
  ])

  const resolveParticipantDisplayName = useCallback(
    (userId: string) =>
      voiceParticipantDisplayName(userId, users, auth.user),
    [auth.user, users],
  )

  const renderAvatarRoster = useCallback(
    (options?: { compact?: boolean; rosterParticipants?: typeof participants }) => (
      <VoiceStageAvatarRoster
        participants={options?.rosterParticipants ?? participants}
        users={users}
        currentUser={auth.user}
        speakingUserIds={voiceSession.speakingUserIds}
        displayName={resolveParticipantDisplayName}
        dimmedUserId={
          connecting && auth.user?._id ? auth.user._id : undefined
        }
        compact={options?.compact}
        speakingEnabled={inThisVoiceCall}
      />
    ),
    [
      auth.user,
      connecting,
      inThisVoiceCall,
      participants,
      resolveParticipantDisplayName,
      users,
      voiceSession.speakingUserIds,
    ],
  )

  const renderTile = useCallback(
    (
      item: VoiceStageMediaItem,
      variant: 'grid' | 'focus' | 'strip' | 'fullscreen',
      onStreamAspectRatioChange?: (aspectRatio: number) => void,
    ) => {
      const isLocal = isVoiceLocalUserId(item.userId, auth.user?._id ?? null)
      return (
        <StageMediaTile
          key={item.id}
          item={item}
          user={users[item.userId] ?? (isLocal ? auth.user ?? undefined : undefined)}
          participant={participantsById.get(item.userId)}
          displayName={voiceParticipantDisplayName(
            item.userId,
            users,
            auth.user,
          )}
          dimmed={connecting && isLocal}
          speaking={
            inThisVoiceCall &&
            item.kind !== 'screen' &&
            voiceSession.speakingUserIds.has(item.userId)
          }
          variant={variant}
          onFocus={focusMedia}
          onSetSubscribed={voiceStage.setStageMediaSubscribed}
          onStreamAspectRatioChange={onStreamAspectRatioChange}
        />
      )
    },
    [
      auth.user,
      connecting,
      focusMedia,
      inThisVoiceCall,
      participantsById,
      users,
      voiceStage.setStageMediaSubscribed,
      voiceSession.speakingUserIds,
    ],
  )

  const renderStageSurface = (
    surfaceRef: Ref<HTMLDivElement> | undefined,
    presentation: 'embedded' | 'popout',
  ) => (
    <div
      ref={surfaceRef}
      data-voice-stage-surface={presentation}
      className={cn(
        // VoiceStage is a media canvas: its surface stays black in every theme.
        'relative flex min-h-0 min-w-0 flex-col overflow-hidden bg-black text-white',
        presentation === 'popout' && 'h-[100dvh] w-full',
        presentation === 'embedded' && 'h-full min-h-0 flex-1',
        presentation === 'popout' &&
          voiceStage.stageFullscreen &&
          'fixed inset-0 z-[50]',
        presentation === 'embedded' &&
          voiceStage.stageFullscreen &&
          !popoutOpen &&
          !mobileDrawer &&
          'fixed inset-0 z-[300]',
      )}
    >
      <div
        className={cn(
          'flex min-h-0 flex-1 flex-col overflow-hidden',
          mobileDrawer
            ? 'px-2 pt-12 pb-[calc(4.5rem+env(safe-area-inset-bottom,0px))]'
            : voiceStageContentInsetClass,
        )}
      >
        {participants.length === 0 && mediaItems.length === 0 ? (
          isDmVoiceStage && voiceCall ? (
            <VoiceStageWaitingCall
              voiceCall={voiceCall}
              voiceCallIncoming={voiceCallIncoming}
              users={users}
              channelRecipients={
                'recipients' in channel ? channel.recipients : []
              }
              currentUserId={auth.user?._id}
              displayName={resolveParticipantDisplayName}
            />
          ) : (
            <EmptyVoiceStage
              title={title}
              joinLabel={resolvedJoinLabel ?? 'Войти'}
              onJoin={() => void voiceSession.join(channelId)}
            />
          )
        ) : showRemoteJoinPreview ? (
          <VoiceStageJoinPreview
            title={title}
            participants={participants}
            users={users}
            currentUser={auth.user}
            displayName={resolveParticipantDisplayName}
            joinLabel={
              resolvedJoinLabel ?? 'Присоединиться к голосовому каналу'
            }
            onJoin={() => void voiceSession.join(channelId)}
          />
        ) : focusedItem ? (
          <VoiceStageFocusStage
            focusedItem={focusedItem}
            mediaItems={gridMediaItems}
            chromeVisible={chromeVisible}
            renderTile={renderTile}
          />
        ) : useAvatarRosterLayout ? (
          renderAvatarRoster()
        ) : isDmVoiceStage && videoMediaItems.length > 0 ? (
          <div className="flex min-h-0 flex-1 flex-col gap-2">
            <VoiceStageGrid
              items={videoMediaItems}
              renderTile={renderTile}
            />
            {avatarOnlyParticipants.length > 0
              ? renderAvatarRoster({
                  compact: true,
                  rosterParticipants: avatarOnlyParticipants,
                })
              : null}
          </div>
        ) : (
          <VoiceStageGrid
            items={gridMediaItems}
            inviteSlot={
              showInviteSlot ? (
                <VoiceStageInviteTile channelId={channelId} />
              ) : undefined
            }
            renderTile={renderTile}
          />
        )}
      </div>

      <header
        data-voice-stage-chrome
        className={cn(
          'absolute inset-x-0 top-0 z-50 flex min-h-12 items-center gap-2 bg-gradient-to-b from-black via-black/80 to-transparent px-4 pt-1 pb-5',
          voiceStageChromeMotion(chromeVisible, 'top'),
        )}
      >
        {onClose ? (
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="size-9 shrink-0 text-white/70 hover:bg-white/10 hover:text-white"
            aria-label="Свернуть"
            title="Свернуть"
            onClick={onClose}
          >
            <ChevronDownIcon className="size-5" />
          </Button>
        ) : null}
        {dmHeader ? (
          <>
            <UserAvatar
              user={dmHeader.user}
              className="size-8 shrink-0"
              fallbackClassName="size-8 text-xs"
              showPresence
              presenceRingClassName="border-black"
            />
            <div className="flex min-w-0 flex-1 items-center gap-2">
              <h1 className="min-w-0 text-sm font-semibold text-white">
                {dmHeader.onOpenProfile ? (
                  <button
                    type="button"
                    className="block max-w-full truncate rounded-sm text-left font-semibold text-white transition-colors hover:text-white/80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/40"
                    onClick={dmHeader.onOpenProfile}
                  >
                    {title}
                  </button>
                ) : (
                  <span className="block truncate">{title}</span>
                )}
              </h1>
              {dmHeader.aliases.length > 0 ? (
                <>
                  <span className="shrink-0 text-white/35" aria-hidden>
                    |
                  </span>
                  <span className="shrink-0 text-[10px] font-semibold uppercase tracking-wide text-white/55">
                    AKA
                  </span>
                  <span className="min-w-0 truncate text-xs text-white/70">
                    {dmHeader.aliases.join(', ')}
                  </span>
                </>
              ) : null}
              {dmHeader.loading ? (
                <span className="shrink-0 text-xs text-white/50">загрузка…</span>
              ) : null}
            </div>
          </>
        ) : (
          <>
            <VoiceChannelIcon
              channel={channel}
              server={server}
              className="size-5 text-white/60"
            />
            <h1
              className="flex min-w-0 flex-1 items-center gap-1.5 text-sm font-semibold"
              title={
                focusedMediaHeader
                  ? `${title} · ${focusedMediaHeader.kindLabel} ${focusedMediaHeader.displayName}`
                  : title
              }
            >
              <span className="flex min-w-0 flex-1 items-center gap-1.5 truncate">
                <span className="truncate">{title}</span>
                {focusedMediaHeader ? (
                  <>
                    <span className="shrink-0 text-white/45" aria-hidden>
                      •
                    </span>
                    <UserAvatar
                      user={focusedMediaHeader.user}
                      className="size-5"
                      fallbackClassName="size-5 text-[10px]"
                      showPresence={false}
                    />
                    <span className="shrink-0 text-white/70">
                      {focusedMediaHeader.kindLabel}
                    </span>
                    <span className="min-w-0 truncate">
                      {focusedMediaHeader.displayName}
                    </span>
                  </>
                ) : null}
              </span>
              {focusedMediaHeader?.showOnAir ? (
                <VoiceOnAirBadge className="ml-1 shrink-0" />
              ) : null}
            </h1>
          </>
        )}
        {dmHeader && focusedMediaHeader ? (
          <div
            className="flex min-w-0 max-w-[40%] items-center gap-1.5 truncate text-sm font-semibold text-white/80"
            title={`${focusedMediaHeader.kindLabel} ${focusedMediaHeader.displayName}`}
          >
            <span className="shrink-0 text-white/45" aria-hidden>
              •
            </span>
            <UserAvatar
              user={focusedMediaHeader.user}
              className="size-5"
              fallbackClassName="size-5 text-[10px]"
              showPresence={false}
            />
            <span className="shrink-0">{focusedMediaHeader.kindLabel}</span>
            <span className="min-w-0 truncate">
              {focusedMediaHeader.displayName}
            </span>
            {focusedMediaHeader.showOnAir ? (
              <VoiceOnAirBadge className="ml-1 shrink-0" />
            ) : null}
          </div>
        ) : null}
        {headerTrailing ? (
          <div className="flex shrink-0 items-center gap-1">{headerTrailing}</div>
        ) : null}
        {presentation === 'embedded' && showChatToggle && !mobileDrawer ? (
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className={cn(
              'size-9 shrink-0 text-white/70 hover:bg-white/10 hover:text-white',
              chatOpen && 'bg-white/15 text-white',
            )}
            title={chatOpen ? 'Скрыть чат' : 'Открыть чат'}
            aria-pressed={chatOpen}
            onClick={onToggleChat}
          >
            <MessageSquareIcon className="size-5" />
          </Button>
        ) : null}
      </header>

      <div
        data-voice-stage-chrome
        className={cn(
          mobileDrawer
            ? 'absolute inset-x-0 bottom-0 z-50 px-3 pb-[calc(env(safe-area-inset-bottom,0px)+0.5rem)]'
            : voiceStageControlsChromeClass,
          voiceStageChromeMotion(chromeVisible, 'bottom'),
        )}
      >
        {showCenteredJoin ? null : mobileDrawer ? (
          <VoiceStageControls
            channelId={channelId}
            inCall={inThisVoiceCall}
            connecting={connecting}
            joinLabel={resolvedJoinLabel}
            mobileDrawer
            chatOpen={chatOpen}
            onToggleChat={onToggleChat}
            incomingCall={voiceCallIncoming && voiceCall?.phase === 'ringing'}
            declineLabel={
              channel.channel_type === 'DirectMessage' ? 'Отклонить' : 'Скрыть'
            }
            onDeclineIncomingCall={onDeclineVoiceCall}
          />
        ) : (
          <>
            <div aria-hidden />
            <div className={voiceStageControlsChromeCenterClass}>
              <VoiceStageControls
                channelId={channelId}
                inCall={inThisVoiceCall}
                connecting={connecting}
                joinLabel={resolvedJoinLabel}
                overlay
                incomingCall={voiceCallIncoming && voiceCall?.phase === 'ringing'}
                declineLabel={
                  channel.channel_type === 'DirectMessage' ? 'Отклонить' : 'Скрыть'
                }
                onDeclineIncomingCall={onDeclineVoiceCall}
              />
            </div>
            <div className={voiceStageControlsChromeTrailingClass}>
              <div className="flex items-center gap-1">
                {focusedItem?.kind === 'screen' && !focusedItem.isLocal ? (
                  <VoiceStageStreamVolumeControl userId={focusedItem.userId} />
                ) : null}
                <VoiceStagePopoutButton
                  active={popoutOpen}
                  disabled={!canToggleStageFullscreen}
                  onClick={toggleStagePopout}
                />
                <VoiceStageFullscreenButton
                  active={voiceStage.stageFullscreen}
                  disabled={!canToggleStageFullscreen}
                  onClick={voiceStage.toggleStageFullscreen}
                />
              </div>
            </div>
          </>
        )}
      </div>

    </div>
  )

  return (
    <>
      {popoutOpen ? (
        <VoiceStagePopoutPlaceholder
          title={title}
          onReturn={closePopout}
          onFocusPopout={() => {
            if (popoutWindow && !popoutWindow.closed) {
              popoutWindow.focus()
            }
          }}
        />
      ) : null}
      {!popoutOpen ? (
        <div className="flex h-full min-h-0 min-w-0 flex-1 flex-col">
          {renderStageSurface(stageRef, 'embedded')}
        </div>
      ) : null}
      {popoutOpen && popoutWindow ? (
        <VoiceStagePopout
          childWindow={popoutWindow}
          title={title}
          onClose={closePopout}
        >
          {renderStageSurface(stageRef, 'popout')}
        </VoiceStagePopout>
      ) : null}
    </>
  )
}

function VoiceStageWaitingCall({
  voiceCall,
  voiceCallIncoming,
  users,
  channelRecipients,
  currentUserId,
  displayName,
}: {
  voiceCall: VoiceCallState
  voiceCallIncoming: boolean
  users: Record<string, User | undefined>
  channelRecipients: string[]
  currentUserId?: string
  displayName: (userId: string) => string
}) {
  const counterpartId = voiceCallIncoming
    ? voiceCall.initiatorId
    : (voiceCall.recipients.find((userId) => userId !== currentUserId) ??
      voiceCall.declinedRecipients.find((userId) => userId !== currentUserId) ??
      channelRecipients.find((userId) => userId !== currentUserId) ??
      voiceCall.initiatorId)
  const counterpart = users[counterpartId]
  const counterpartName = displayName(counterpartId)
  const counterpartDeclined = Boolean(
    currentUserId &&
      voiceCall.initiatorId === currentUserId &&
      voiceCall.declinedRecipients.includes(counterpartId),
  )
  let statusLabel = 'Звонок идёт'
  if (voiceCallIncoming) {
    statusLabel = `${counterpartName} звонит`
  } else if (counterpartDeclined) {
    statusLabel = `${counterpartName} отклонил звонок`
  } else if (voiceCall.phase === 'ringing') {
    statusLabel = `Звоним ${counterpartName}`
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-4 px-4 text-center">
      <div className="rounded-full ring-2 ring-chart-3 ring-offset-2 ring-offset-background">
        <UserAvatar
          user={counterpart}
          className="size-28 sm:size-32 md:size-36"
          fallbackClassName="size-28 text-2xl sm:size-32 md:size-36"
          showPresence={false}
        />
      </div>
      <div className="space-y-1">
        <p className="text-lg font-semibold text-white">{statusLabel}</p>
        <p className="text-sm text-white/60">
          {counterpartDeclined
            ? 'Звонок останется доступен, пока вы в канале'
            : voiceCall.phase === 'ringing'
              ? 'Ответьте на звонок или отклоните его'
              : 'Подключитесь, чтобы присоединиться к разговору'}
        </p>
      </div>
    </div>
  )
}

function EmptyVoiceStage({
  title,
  joinLabel,
  onJoin,
}: {
  title: string
  joinLabel: string
  onJoin: () => void
}) {
  return (
    <div className="flex min-h-[min(50vh,20rem)] flex-1 flex-col items-center justify-center gap-3 px-4 text-center">
      <h2 className="max-w-md truncate text-2xl font-bold">{title}</h2>
      <p className="text-sm text-muted-foreground">В канале никого нет</p>
      <Button type="button" size="lg" className="mt-2" onClick={onJoin}>
        {joinLabel}
      </Button>
    </div>
  )
}

function additionalParticipantLabel(count: number) {
  const mod10 = count % 10
  const mod100 = count % 100
  if (mod10 === 1 && mod100 !== 11) return `${count} участник`
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) {
    return `${count} участника`
  }
  return `${count} участников`
}

function VoiceStageJoinPreview({
  title,
  participants,
  users,
  currentUser,
  displayName,
  joinLabel,
  onJoin,
}: {
  title: string
  participants: readonly UserVoiceState[]
  users: Record<string, User | undefined>
  currentUser?: User | null
  displayName: (userId: string) => string
  joinLabel: string
  onJoin: () => void
}) {
  const visibleParticipants = participants.slice(0, 4)
  const hiddenParticipantCount = participants.length - visibleParticipants.length
  const firstParticipantName = displayName(participants[0].id)
  const status =
    participants.length === 1
      ? `${firstParticipantName} сейчас в голосовом чате`
      : `${firstParticipantName} и ещё ${additionalParticipantLabel(
          participants.length - 1,
        )} сейчас в голосовом чате`

  return (
    <div className="grid min-h-[min(50vh,24rem)] flex-1 place-items-center px-4 text-center">
      <div className="flex translate-y-3 flex-col items-center gap-4">
        <div className="grid h-24 w-44 place-items-center rounded-xl bg-muted/80 px-5">
          <ul
            className="flex -space-x-3"
            aria-label="Участники голосового канала"
          >
            {visibleParticipants.map((participant) => {
              const user =
                users[participant.id] ??
                (participant.id === currentUser?._id
                  ? currentUser ?? undefined
                  : undefined)
              return (
                <li key={participant.id} title={displayName(participant.id)}>
                  <UserAvatar
                    user={user}
                    className="size-12 ring-2 ring-muted"
                    fallbackClassName="size-12 text-sm"
                    showPresence={false}
                  />
                </li>
              )
            })}
            {hiddenParticipantCount > 0 ? (
              <li
                className="relative grid size-12 place-items-center rounded-full bg-accent text-sm font-semibold text-accent-foreground ring-2 ring-muted"
                aria-label={`И ещё ${additionalParticipantLabel(hiddenParticipantCount)}`}
              >
                +{hiddenParticipantCount}
              </li>
            ) : null}
          </ul>
        </div>
        <div className="space-y-1.5">
          <h2 className="max-w-md truncate text-3xl font-bold">{title}</h2>
          <p className="max-w-lg text-sm text-muted-foreground">{status}</p>
        </div>
        <Button type="button" size="lg" className="mt-1" onClick={onJoin}>
          {joinLabel}
        </Button>
      </div>
    </div>
  )
}
