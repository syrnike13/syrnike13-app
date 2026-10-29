import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
  type Ref,
} from 'react'
import { useTranslations } from '@syrnike13/ui/i18n'
import { Spinner } from '@syrnike13/ui/primitives/spinner'
import {
  MessageSquareIcon,
  ChevronDownIcon,
} from '#/components/icons'
import { VoiceChannelIcon } from '#/components/icons/voice-channel-icon'
import type { Channel, User } from '@syrnike13/api-types'
import type {
  UserVoiceState,
  VoiceCallState,
} from '#/features/sync/voice-types'

import { Button } from '@syrnike13/ui/primitives/button'
import { UserAvatar } from '#/components/user/user-avatar'
import { VoiceOnAirBadge } from '#/components/voice/voice-participant-icons'
import { VoiceStageFocusStage } from '#/components/voice/voice-stage-focus-stage'
import { StageMediaTile } from '#/components/voice/voice-stage-media-tile'
import {
  VoiceStageActivityTile,
  type VoiceStageActivityItem,
} from '#/components/voice/voice-stage-activity-tile'
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
import { activityStageItemId } from '#/features/activities/activity-stage'
import {
  activityStore,
  isActivityParticipant,
} from '#/features/activities/activity-store'
import {
  useActivityApplication,
  useActivityInstance,
} from '#/features/activities/use-activities'
import {
  getChannelVoiceParticipants,
  sameVoiceParticipantList,
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
import { useDevVoiceStageGhosts } from '#/features/voice/dev-voice-stage-ghosts'
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
import { streamViewerIds } from '#/features/voice/stream-viewers'
import {
  VoiceStreamViewers,
  type StreamViewer,
} from '#/components/voice/voice-stream-viewers'
import {
  buildVoiceStageViewSessions,
  type VoiceStageViewSession,
} from '#/features/voice/voice-stage-view-session'
import {
  canEndActivities,
  canInviteToChannel,
} from '#/features/authorization/authorization'
import { uiFeatureFlags } from '#/lib/ui-feature-flags'
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
  onToggleChat?: () => void
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
  popoutSurface?: boolean
}

const EMPTY_STAGE_MEDIA_ITEMS: readonly VoiceStageMediaItem[] = []
const ActivityLauncher = lazy(() =>
  import('#/features/activities/activity-launcher').then((module) => ({
    default: module.ActivityLauncher,
  })),
)

type VoiceStageItem = VoiceStageMediaItem | VoiceStageActivityItem

function isVoiceStageActivityItem(
  item: VoiceStageItem,
): item is VoiceStageActivityItem {
  return item.kind === 'activity'
}

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
  popoutSurface = false,
}: VoiceStageViewProps) {
  const t = useTranslations('voice')
  const tA = useTranslations('activities')
  const auth = useAuth()
  const voiceSession = useVoiceSession()
  const voiceStage = useVoiceStage()
  const channelId = channel._id
  const syncedUsers = useSyncStore((s) => s.users)
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
  const storeParticipants = useSyncStore(
    (s) => getChannelVoiceParticipants(s, channelId, auth.user?._id),
    sameVoiceParticipantList,
  )
  const inVoiceSession = isVoiceSessionInChannel(voiceSession, channelId)
  const inThisVoiceCall = voiceSession.status === 'connected' && inVoiceSession
  const connecting = voiceSession.status === 'connecting' && inVoiceSession
  const devGhosts = useDevVoiceStageGhosts({ enabled: inThisVoiceCall })
  const users = useMemo(
    () =>
      Object.keys(devGhosts.users).length > 0
        ? { ...syncedUsers, ...devGhosts.users }
        : syncedUsers,
    [devGhosts.users, syncedUsers],
  )
  const channelActivitiesEnabled = uiFeatureFlags.channelActivities
  const activityInstance = useActivityInstance(
    channelActivitiesEnabled && inThisVoiceCall ? channelId : null,
  )
  const activityApplication = useActivityApplication(
    activityInstance?.application_id,
  )
  const activityTitle = activityApplication?.name ?? tA('unknownApplication')
  const canEndChannelActivities = useSyncStore(() =>
    canEndActivities(channelId),
  )
  const currentUserId = auth.user?._id
  const closeActivityLauncher = useCallback(() => {
    voiceStage.setActivityLauncherOpen(false)
  }, [voiceStage.setActivityLauncherOpen])

  useEffect(() => {
    if (
      (!channelActivitiesEnabled || !inThisVoiceCall) &&
      voiceStage.activityLauncherOpen
    ) {
      voiceStage.setActivityLauncherOpen(false)
    }
  }, [
    channelActivitiesEnabled,
    inThisVoiceCall,
    voiceStage.activityLauncherOpen,
    voiceStage.setActivityLauncherOpen,
  ])
  const isDmVoiceStage =
    channel.channel_type === 'DirectMessage' || channel.channel_type === 'Group'
  const resolvedJoinLabel =
    joinButtonLabel ?? (isDmVoiceStage ? t('actions.join') : undefined)
  const [requestedMode, setRequestedMode] =
    useState<VoiceStageLayoutMode>('grid')
  const { popoutWindow, closeStagePopout: closePopout } = voiceStage
  const popoutOpen =
    voiceStage.popoutChannelId === channelId &&
    popoutWindow != null &&
    !popoutWindow.closed
  const { stageRef, chromeVisible } = useVoiceStageChromeVisible(
    popoutOpen ? 'popout' : 'embedded',
  )

  useEffect(() => {
    if (popoutSurface) return
    return voiceStage.registerStageView(channelId)
  }, [channelId, popoutSurface, voiceStage.registerStageView])

  const realParticipants = useChannelVoiceParticipantsWithLocalOverride(
    channelId,
    storeParticipants,
    inVoiceSession ? auth.user?._id : undefined,
    inVoiceSession ? voiceSession.micPublishing : undefined,
    inVoiceSession ? voiceSession.deafened : undefined,
  )
  const participants = useMemo(
    () =>
      devGhosts.participants.length > 0
        ? [...realParticipants, ...devGhosts.participants]
        : realParticipants,
    [devGhosts.participants, realParticipants],
  )
  const participantsById = useMemo(
    () =>
      new Map(participants.map((participant) => [participant.id, participant])),
    [participants],
  )
  const mediaItems = useMemo(() => {
    const stageItems =
      voiceStage.stageChannelId === channelId
        ? voiceStage.stageMediaItems
        : EMPTY_STAGE_MEDIA_ITEMS
    return devGhosts.mediaItems.length > 0
      ? [...devGhosts.mediaItems, ...stageItems]
      : stageItems
  }, [
    channelId,
    devGhosts.mediaItems,
    voiceStage.stageChannelId,
    voiceStage.stageMediaItems,
  ])
  const speakingUserIds = useMemo<ReadonlySet<string>>(
    () =>
      devGhosts.speakingUserIds.size > 0
        ? new Set([
            ...voiceSession.speakingUserIds,
            ...devGhosts.speakingUserIds,
          ])
        : voiceSession.speakingUserIds,
    [devGhosts.speakingUserIds, voiceSession.speakingUserIds],
  )
  const gridMediaItems = useMemo(
    () => sortStageMediaItemsForGrid(mediaItems),
    [mediaItems],
  )
  const activityStageItem = useMemo<VoiceStageActivityItem | null>(
    () =>
      activityInstance
        ? {
            id: activityStageItemId(activityInstance.id),
            kind: 'activity',
            instance: activityInstance,
          }
        : null,
    [activityInstance],
  )
  const stageItems = useMemo<readonly VoiceStageItem[]>(
    () =>
      activityStageItem
        ? [activityStageItem, ...gridMediaItems]
        : gridMediaItems,
    [activityStageItem, gridMediaItems],
  )
  const videoMediaItems = useMemo(
    () => filterStageVideoMediaItems(gridMediaItems),
    [gridMediaItems],
  )
  const stageItemIds = useMemo(
    () => stageItems.map((item) => item.id),
    [stageItems],
  )
  const videoUserIds = useMemo(
    () => new Set(videoMediaItems.map((item) => item.userId)),
    [videoMediaItems],
  )
  const avatarOnlyParticipants = useMemo(
    () =>
      participants.filter((participant) => !videoUserIds.has(participant.id)),
    [participants, videoUserIds],
  )
  const useAvatarRosterLayout =
    !activityStageItem &&
    videoMediaItems.length === 0 &&
    gridMediaItems.length === 0 &&
    participants.length > 0

  useEffect(() => {
    if (!voiceStage.activityLauncherOpen || !activityStageItem) return
    voiceStage.setActivityLauncherOpen(false)
    voiceStage.setFocusedMediaId(activityStageItem.id)
    setRequestedMode('focus')
  }, [
    activityStageItem,
    voiceStage.activityLauncherOpen,
    voiceStage.setActivityLauncherOpen,
    voiceStage.setFocusedMediaId,
  ])

  useEffect(() => {
    if (!voiceStage.stageFocusNonce) return
    const mediaId = voiceStage.focusedMediaId
    if (!mediaId || !stageItemIds.includes(mediaId)) return
    setRequestedMode('focus')
  }, [stageItemIds, voiceStage.focusedMediaId, voiceStage.stageFocusNonce])

  const layoutMode = resolveStageLayoutMode({
    requestedMode,
    focusedMediaId: voiceStage.focusedMediaId,
    visibleMediaIds: stageItemIds,
  })
  const focusedItem =
    layoutMode === 'focus'
      ? (stageItems.find((item) => item.id === voiceStage.focusedMediaId) ??
        null)
      : null
  const focusedMediaHeader = useMemo(() => {
    if (!focusedItem) return null
    if (isVoiceStageActivityItem(focusedItem)) {
      return {
        user: undefined,
        kindLabel: t('stage.activity'),
        displayName: activityTitle,
        showOnAir: false,
        showAvatar: false,
      }
    }
    const kindLabel = stageMediaKindLabel(focusedItem.kind, t)
    if (!kindLabel) return null

    const isLocal = isVoiceLocalUserId(
      focusedItem.userId,
      auth.user?._id ?? null,
    )
    const user =
      users[focusedItem.userId] ??
      (isLocal ? (auth.user ?? undefined) : undefined)
    const participant = participantsById.get(focusedItem.userId)

    return {
      user,
      kindLabel,
      displayName: voiceParticipantDisplayName(
        focusedItem.userId,
        users,
        auth.user,
        t,
      ),
      showOnAir:
        focusedItem.kind === 'screen' && Boolean(participant?.screensharing),
      showAvatar: true,
    }
  }, [activityTitle, auth.user, focusedItem, participantsById, t, users])
  const canToggleStageFullscreen =
    !mobileDrawer && (participants.length > 0 || stageItems.length > 0)
  const canInvite =
    server && channel.channel_type === 'TextChannel'
      ? canInviteToChannel(server, channel, member, auth.user?._id)
      : false
  const showInviteSlot =
    canInvite &&
    layoutMode === 'grid' &&
    !voiceStage.stageFullscreen &&
    shouldShowVoiceInviteSlot(participants.length)
  const showEmptyStage =
    participants.length === 0 &&
    stageItems.length === 0 &&
    !(isDmVoiceStage && voiceCall)
  const showRemoteJoinPreview =
    useAvatarRosterLayout && !inThisVoiceCall && !connecting && !isDmVoiceStage
  const showCenteredJoin =
    !inThisVoiceCall && !connecting && (showEmptyStage || showRemoteJoinPreview)

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
    if (!voiceStage.stageFullscreen || (popoutOpen && !popoutSurface)) return

    function onKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        voiceStage.toggleStageFullscreen()
      }
    }

    const targetWindow = popoutSurface ? popoutWindow : window
    targetWindow?.addEventListener('keydown', onKeyDown)
    return () => targetWindow?.removeEventListener('keydown', onKeyDown)
  }, [voiceStage, popoutOpen, popoutSurface, popoutWindow])

  const toggleStagePopout = useCallback(() => {
    if (popoutOpen && popoutWindow) {
      closePopout()
      return
    }
    if (!canToggleStageFullscreen) return

    if (voiceStage.stageFullscreen) {
      voiceStage.toggleStageFullscreen()
    }

    voiceStage.openStagePopout(channelId)
  }, [
    canToggleStageFullscreen,
    channelId,
    closePopout,
    popoutOpen,
    popoutWindow,
    voiceStage,
  ])

  const resolveParticipantDisplayName = useCallback(
    (userId: string) =>
      voiceParticipantDisplayName(userId, users, auth.user, t),
    [auth.user, t, users],
  )

  const streamViewersByOwner = useMemo(() => {
    const viewersByOwner = new Map<string, StreamViewer[]>()
    for (const owner of participants) {
      const viewers = streamViewerIds(participants, owner.id)
      if (viewers.length === 0) continue
      viewersByOwner.set(
        owner.id,
        viewers.map((viewerId) => ({
          id: viewerId,
          user:
            users[viewerId] ??
            (viewerId === auth.user?._id ? (auth.user ?? undefined) : undefined),
          displayName: resolveParticipantDisplayName(viewerId),
        })),
      )
    }
    return viewersByOwner
  }, [auth.user, participants, resolveParticipantDisplayName, users])

  const activityParticipants = useMemo<StreamViewer[]>(
    () =>
      activityInstance
        ? activityInstance.participants.map(({ user_id: userId }) => ({
            id: userId,
            user:
              users[userId] ??
              (userId === auth.user?._id ? (auth.user ?? undefined) : undefined),
            displayName: resolveParticipantDisplayName(userId),
          }))
        : [],
    [activityInstance, auth.user, resolveParticipantDisplayName, users],
  )

  const focusedViewers = useMemo(
    () =>
      focusedItem?.kind === 'screen'
        ? (streamViewersByOwner.get(focusedItem.userId) ?? [])
        : focusedItem?.kind === 'activity'
          ? activityParticipants
          : [],
    [activityParticipants, focusedItem, streamViewersByOwner],
  )
  const focusedViewerLabels =
    focusedItem?.kind === 'activity' ? 'activityParticipants' : 'viewers'

  const viewSessions = useMemo(
    () =>
      buildVoiceStageViewSessions({
        viewedRemoteScreenIds: voiceStage.viewedRemoteScreenIds,
        screenDisplayName: resolveParticipantDisplayName,
        activity: activityStageItem
          ? {
              stageItemId: activityStageItem.id,
              instanceId: activityStageItem.instance.id,
              channelId: activityStageItem.instance.channel_id,
              label: activityTitle,
              joined: isActivityParticipant(
                activityStageItem.instance,
                currentUserId,
              ),
            }
          : null,
      }),
    [
      activityStageItem,
      activityTitle,
      currentUserId,
      resolveParticipantDisplayName,
      voiceStage.viewedRemoteScreenIds,
    ],
  )

  const exitViewSession = useCallback(
    (session: VoiceStageViewSession) => {
      if (session.kind === 'stream') {
        voiceStage.setStageMediaSubscribed(session.stageItemId, false)
      } else {
        activityStore
          .leave(session.channelId, session.instanceId)
          .catch(() => undefined)
      }

      if (voiceStage.focusedMediaId === session.stageItemId) {
        voiceStage.setFocusedMediaId(null)
        setRequestedMode('grid')
      }
    },
    [
      voiceStage.focusedMediaId,
      voiceStage.setFocusedMediaId,
      voiceStage.setStageMediaSubscribed,
    ],
  )

  const renderAvatarRoster = useCallback(
    (options?: {
      compact?: boolean
      rosterParticipants?: typeof participants
    }) => (
      <VoiceStageAvatarRoster
        participants={options?.rosterParticipants ?? participants}
        users={users}
        currentUser={auth.user}
        speakingUserIds={speakingUserIds}
        displayName={resolveParticipantDisplayName}
        dimmedUserId={connecting && auth.user?._id ? auth.user._id : undefined}
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
      speakingUserIds,
    ],
  )

  const renderTile = useCallback(
    (
      item: VoiceStageItem,
      variant: 'grid' | 'focus' | 'strip' | 'fullscreen',
      onStreamAspectRatioChange?: (aspectRatio: number) => void,
    ) => {
      if (isVoiceStageActivityItem(item)) {
        if (!currentUserId) return null
        return (
          <VoiceStageActivityTile
            key={item.id}
            item={item}
            application={activityApplication}
            currentUserId={currentUserId}
            participants={activityParticipants}
            canEnd={
              item.instance.host_id === currentUserId || canEndChannelActivities
            }
            variant={variant}
            popout={popoutSurface}
            onFocus={focusMedia}
            onAspectRatioChange={onStreamAspectRatioChange}
          />
        )
      }
      const isLocal = isVoiceLocalUserId(item.userId, auth.user?._id ?? null)
      return (
        <StageMediaTile
          key={item.id}
          item={item}
          user={
            users[item.userId] ??
            (isLocal ? (auth.user ?? undefined) : undefined)
          }
          participant={participantsById.get(item.userId)}
          displayName={voiceParticipantDisplayName(
            item.userId,
            users,
            auth.user,
            t,
          )}
          dimmed={connecting && isLocal}
          speaking={
            inThisVoiceCall &&
            item.kind !== 'screen' &&
            speakingUserIds.has(item.userId)
          }
          variant={variant}
          onFocus={focusMedia}
          onSetSubscribed={voiceStage.setStageMediaSubscribed}
          onStreamAspectRatioChange={onStreamAspectRatioChange}
        />
      )
    },
    [
      activityApplication,
      activityParticipants,
      auth.user,
      canEndChannelActivities,
      connecting,
      currentUserId,
      focusMedia,
      popoutSurface,
      inThisVoiceCall,
      participantsById,
      t,
      users,
      voiceStage.setStageMediaSubscribed,
      speakingUserIds,
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
        'relative flex min-h-0 min-w-0 flex-col overflow-hidden bg-media-backdrop text-on-media',
        presentation === 'popout' && 'h-dvh w-full',
        presentation === 'embedded' && 'h-full min-h-0 flex-1',
        presentation === 'popout' &&
          voiceStage.stageFullscreen &&
          'fixed inset-0 z-50',
        presentation === 'embedded' &&
          voiceStage.stageFullscreen &&
          !popoutOpen &&
          !mobileDrawer &&
          'fixed inset-0 z-300',
      )}
    >
      <div
        className={cn(
          'flex min-h-0 flex-1 flex-col overflow-hidden',
          mobileDrawer
            ? 'px-2 pt-12 voice-stage-safe-pb'
            : voiceStageContentInsetClass,
        )}
      >
        {channelActivitiesEnabled &&
        voiceStage.activityLauncherOpen &&
        currentUserId ? (
          <Suspense
            fallback={
              <div className="flex min-h-0 flex-1 items-center justify-center text-muted-foreground">
                <Spinner className="mr-2 size-5" />
                {t('stage.loadingActivity')}
              </div>
            }
          >
            <ActivityLauncher
              channelId={channelId}
              onClose={closeActivityLauncher}
            />
          </Suspense>
        ) : participants.length === 0 && stageItems.length === 0 ? (
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
            <VoiceStageJoinPrompt
              title={title}
              participants={[]}
              users={users}
              displayName={resolveParticipantDisplayName}
              joinLabel={resolvedJoinLabel ?? t('actions.join')}
              onJoin={() => void voiceSession.join(channelId)}
            />
          )
        ) : showRemoteJoinPreview ? (
          <VoiceStageJoinPrompt
            title={title}
            participants={participants}
            users={users}
            currentUser={auth.user}
            displayName={resolveParticipantDisplayName}
            joinLabel={resolvedJoinLabel ?? t('actions.joinChannel')}
            onJoin={() => void voiceSession.join(channelId)}
          />
        ) : focusedItem ? (
          <VoiceStageFocusStage
            focusedItem={focusedItem}
            mediaItems={stageItems}
            chromeVisible={chromeVisible}
            renderTile={renderTile}
          />
        ) : useAvatarRosterLayout ? (
          renderAvatarRoster()
        ) : isDmVoiceStage &&
          videoMediaItems.length > 0 &&
          !activityStageItem ? (
          <div className="flex min-h-0 flex-1 flex-col gap-2">
            <VoiceStageGrid items={videoMediaItems} renderTile={renderTile} />
            {avatarOnlyParticipants.length > 0
              ? renderAvatarRoster({
                  compact: true,
                  rosterParticipants: avatarOnlyParticipants,
                })
              : null}
          </div>
        ) : (
          <VoiceStageGrid
            items={stageItems}
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
          'absolute inset-x-0 top-0 z-50 flex min-h-12 items-center gap-2 bg-gradient-to-b from-media-backdrop via-media-backdrop/80 to-transparent px-4 pt-1 pb-5',
          voiceStageChromeMotion(chromeVisible, 'top'),
        )}
      >
        {onClose ? (
          <Button
            type="button"
            variant="media"
            size="icon-lg"
            aria-label={t('actions.minimize')}
            title={t('actions.minimize')}
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
            />
            <div className="flex min-w-0 flex-1 items-center gap-2">
              <h1 className="min-w-0 text-base font-semibold text-on-media">
                {dmHeader.onOpenProfile ? (
                  <Button
                    type="button"
                    variant="plain"
                    size="inline"
                    className="block max-w-full truncate text-on-media"
                    onClick={dmHeader.onOpenProfile}
                  >
                    {title}
                  </Button>
                ) : (
                  <span className="block truncate">{title}</span>
                )}
              </h1>
              {dmHeader.aliases.length > 0 ? (
                <>
                  <span className="shrink-0 text-on-media/35" aria-hidden>
                    |
                  </span>
                  <span className="shrink-0 text-xs font-semibold uppercase tracking-wide text-on-media/55">
                    AKA
                  </span>
                  <span className="min-w-0 truncate text-xs text-on-media/70">
                    {dmHeader.aliases.join(', ')}
                  </span>
                </>
              ) : null}
              {dmHeader.loading ? (
                <span className="shrink-0 text-xs text-on-media/50">
                  {t('actions.loading')}
                </span>
              ) : null}
            </div>
          </>
        ) : (
          <>
            <VoiceChannelIcon
              channel={channel}
              server={server}
              className="size-5 text-on-media/60"
            />
            <h1
              className="flex min-w-0 flex-1 items-center gap-1.5 text-base font-semibold"
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
                    <span className="shrink-0 text-on-media/45" aria-hidden>
                      •
                    </span>
                    {focusedMediaHeader.showAvatar ? (
                      <UserAvatar
                        user={focusedMediaHeader.user}
                        className="size-5"
                        fallbackClassName="size-5 text-xs"
                        showPresence={false}
                      />
                    ) : null}
                    <span className="shrink-0 text-on-media/70">
                      {focusedMediaHeader.kindLabel}
                    </span>
                    <span className="min-w-0 truncate">
                      {focusedMediaHeader.displayName}
                    </span>
                  </>
                ) : null}
              </span>
              {focusedViewers.length > 0 ? (
                <VoiceStreamViewers
                  viewers={focusedViewers}
                  variant="avatars"
                  labels={focusedViewerLabels}
                  className="ml-1 shrink-0"
                />
              ) : null}
              {focusedMediaHeader?.showOnAir ? (
                <VoiceOnAirBadge className="ml-1 shrink-0" />
              ) : null}
            </h1>
          </>
        )}
        {dmHeader && focusedMediaHeader ? (
          <div
            className="flex min-w-0 max-w-40/100 items-center gap-1.5 truncate text-sm font-semibold text-on-media/80"
            title={`${focusedMediaHeader.kindLabel} ${focusedMediaHeader.displayName}`}
          >
            <span className="shrink-0 text-on-media/45" aria-hidden>
              •
            </span>
            {focusedMediaHeader.showAvatar ? (
              <UserAvatar
                user={focusedMediaHeader.user}
                className="size-5"
                fallbackClassName="size-5 text-xs"
                showPresence={false}
              />
            ) : null}
            <span className="shrink-0">{focusedMediaHeader.kindLabel}</span>
            <span className="min-w-0 truncate">
              {focusedMediaHeader.displayName}
            </span>
            {focusedViewers.length > 0 ? (
              <VoiceStreamViewers
                viewers={focusedViewers}
                variant="avatars"
                labels={focusedViewerLabels}
                className="ml-1 shrink-0"
              />
            ) : null}
            {focusedMediaHeader.showOnAir ? (
              <VoiceOnAirBadge className="ml-1 shrink-0" />
            ) : null}
          </div>
        ) : null}
        {headerTrailing ? (
          <div className="flex shrink-0 items-center gap-1">
            {headerTrailing}
          </div>
        ) : null}
        {presentation === 'embedded' && showChatToggle && !mobileDrawer ? (
          <Button
            type="button"
            variant="media"
            size="icon-lg"
            title={chatOpen ? t('actions.hideChat') : t('actions.openChat')}
            aria-label={chatOpen ? t('actions.hideChat') : t('actions.openChat')}
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
            ? 'absolute inset-x-0 bottom-0 z-50 px-3 safe-pb-2'
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
              channel.channel_type === 'DirectMessage'
                ? t('actions.decline')
                : t('actions.hide')
            }
            onDeclineIncomingCall={onDeclineVoiceCall}
            viewSessions={viewSessions}
            focusedStageItemId={voiceStage.focusedMediaId}
            onExitViewSession={exitViewSession}
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

                incomingCall={
                  voiceCallIncoming && voiceCall?.phase === 'ringing'
                }
                declineLabel={
                  channel.channel_type === 'DirectMessage'
                    ? t('actions.decline')
                    : t('actions.hide')
                }
                onDeclineIncomingCall={onDeclineVoiceCall}
                viewSessions={viewSessions}
                focusedStageItemId={voiceStage.focusedMediaId}
                onExitViewSession={exitViewSession}
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
      {popoutOpen && !popoutSurface ? (
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
      {!popoutOpen && !popoutSurface ? (
        <div className="flex h-full min-h-0 min-w-0 flex-1 flex-col">
          {renderStageSurface(stageRef, 'embedded')}
        </div>
      ) : null}
      {popoutSurface && popoutOpen && popoutWindow ? (
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
  const t = useTranslations('voice')
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
  let statusLabel = t('stage.callInProgress')
  if (voiceCallIncoming) {
    statusLabel = t('stage.incomingCall', { name: counterpartName })
  } else if (counterpartDeclined) {
    statusLabel = t('stage.callDeclined', { name: counterpartName })
  } else if (voiceCall.phase === 'ringing') {
    statusLabel = t('stage.calling', { name: counterpartName })
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-4 px-4 text-center">
      <div className="rounded-full ring-2 ring-success ring-offset-2 ring-offset-media-backdrop">
        <UserAvatar
          user={counterpart}
          className="size-28 sm:size-32 md:size-36"
          fallbackClassName="size-28 text-2xl sm:size-32 md:size-36"
          showPresence={false}
        />
      </div>
      <div className="space-y-1">
        <p className="text-lg font-semibold text-on-media">{statusLabel}</p>
        <p className="text-sm text-on-media/60">
          {counterpartDeclined
            ? t('stage.callAvailable')
            : voiceCall.phase === 'ringing'
              ? t('stage.answerOrDecline')
              : t('stage.connectToJoin')}
        </p>
      </div>
    </div>
  )
}

/**
 * Before joining: who is in the channel (a stack of up to four avatars), the
 * channel name, a status line and the join button. Empty channels show no
 * avatars.
 */
function VoiceStageJoinPrompt({
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
  const t = useTranslations('voice')
  const visibleParticipants = participants.slice(0, 4)
  const hiddenParticipantCount =
    participants.length - visibleParticipants.length
  const status =
    participants.length === 0
      ? t('stage.noOne')
      : participants.length === 1
        ? t('stage.inVoiceChat', { name: displayName(participants[0]!.id) })
        : t('stage.andMoreInVoiceChat', {
            name: displayName(participants[0]!.id),
            count: participants.length - 1,
          })

  return (
    <div className="flex min-h-voice-tile-sm flex-1 flex-col items-center justify-center gap-4 px-4 text-center">
      {visibleParticipants.length > 0 ? (
        <ul className="flex -space-x-3" aria-label={t('stage.participantsLabel')}>
          {visibleParticipants.map((participant) => {
            const user =
              users[participant.id] ??
              (participant.id === currentUser?._id
                ? (currentUser ?? undefined)
                : undefined)
            return (
              <li
                key={participant.id}
                title={displayName(participant.id)}
                className="rounded-full ring-4 ring-media-backdrop"
              >
                <UserAvatar
                  user={user}
                  className="size-16"
                  fallbackClassName="size-16 text-base"
                  showPresence={false}
                />
              </li>
            )
          })}
          {hiddenParticipantCount > 0 ? (
            <li
              className="grid size-16 place-items-center rounded-full bg-on-media/15 text-base font-semibold text-on-media ring-4 ring-media-backdrop"
              aria-label={t('stage.moreParticipants', {
                count: hiddenParticipantCount,
              })}
            >
              +{hiddenParticipantCount}
            </li>
          ) : null}
        </ul>
      ) : null}
      <div className="flex flex-col gap-1">
        <h2 className="max-w-md truncate text-2xl font-bold text-on-media">
          {title}
        </h2>
        <p className="max-w-lg text-sm text-on-media/60">{status}</p>
      </div>
      <Button type="button" size="lg" onClick={onJoin}>
        {joinLabel}
      </Button>
    </div>
  )
}
