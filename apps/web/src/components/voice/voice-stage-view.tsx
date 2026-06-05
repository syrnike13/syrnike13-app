import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import {
  Maximize2Icon,
  MessageSquareIcon,
  Minimize2Icon,
  Volume2Icon,
} from 'lucide-react'
import type { Channel, User } from '@syrnike13/api-types'
import { toast } from 'sonner'

import { Button } from '#/components/ui/button'
import { VoiceStageFocusStage } from '#/components/voice/voice-stage-focus-stage'
import { StageMediaTile } from '#/components/voice/voice-stage-media-tile'
import { VoiceStageControls } from '#/components/voice/voice-stage-controls'
import { VoiceStageInviteTile } from '#/components/voice/voice-stage-tile'
import { VoiceStagePopout } from '#/components/voice/voice-stage-popout'
import { VoiceStageVideo } from '#/components/voice/voice-stage-video'
import { useAuth } from '#/features/auth/auth-context'
import {
  getChannelVoiceParticipants,
  useMergedChannelVoiceParticipants,
} from '#/features/sync/voice-selectors'
import { useSyncStore } from '#/features/sync/sync-store'
import { useChannelVoiceState } from '#/features/voice/use-channel-voice-state'
import {
  nextStageLayoutModeForMediaClick,
  resolveStageLayoutMode,
  type VoiceStageLayoutMode,
} from '#/features/voice/voice-stage-mode'
import { useVoice, type VoiceStageMediaItem } from '#/features/voice/voice-provider'
import { isVoiceSessionInChannel } from '#/features/voice/voice-mic-status'
import {
  shouldShowVoiceInviteSlot,
  voiceStageContentInsetClass,
  voiceStageGridClass,
} from '#/components/voice/voice-stage-layout'
import {
  useVoiceStageChromeVisible,
  voiceStageChromeMotion,
} from '#/features/voice/use-voice-stage-chrome-visible'
import { canInviteToChannel } from '#/lib/permissions'
import { cn } from '#/lib/utils'

type VoiceStageViewProps = {
  channel: Extract<Channel, { channel_type: 'TextChannel' | 'VoiceChannel' }>
  title: string
  chatOpen: boolean
  onToggleChat: () => void
}

type PopoutState = {
  mediaId: string
  childWindow: Window
}

function participantDisplayName(
  userId: string,
  users: Record<string, User>,
  currentUserId?: string,
) {
  if (userId === currentUserId) return 'Вы'
  const user = users[userId]
  return user?.display_name ?? user?.username ?? 'Участник'
}

function defaultFullscreenItem(items: readonly VoiceStageMediaItem[]) {
  return (
    items.find((item) => item.kind === 'screen' && item.live) ??
    items.find((item) => item.kind === 'camera' && item.live) ??
    items[0] ??
    null
  )
}

export function VoiceStageView({
  channel,
  title,
  chatOpen,
  onToggleChat,
}: VoiceStageViewProps) {
  const auth = useAuth()
  const voice = useVoice()
  const channelId = channel._id
  useChannelVoiceState(channelId)
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
  const inVoiceSession = isVoiceSessionInChannel(voice, channelId)
  const inThisVoiceCall = voice.status === 'connected' && inVoiceSession
  const connecting = voice.status === 'connecting' && inVoiceSession
  const [requestedMode, setRequestedMode] =
    useState<VoiceStageLayoutMode>('grid')
  const [popout, setPopout] = useState<PopoutState | null>(null)
  const popoutRef = useRef<PopoutState | null>(null)
  const { stageRef, chromeVisible } = useVoiceStageChromeVisible()

  useEffect(() => {
    popoutRef.current = popout
  }, [popout])

  useEffect(() => {
    return () => {
      const current = popoutRef.current
      if (current && !current.childWindow.closed) {
        current.childWindow.close()
      }
    }
  }, [])

  const participants = useMergedChannelVoiceParticipants(
    channelId,
    storeParticipants,
    voice.liveChannelParticipants,
    inVoiceSession,
    inVoiceSession ? auth.user?._id : undefined,
    inVoiceSession ? voice.micPublishing : undefined,
    inVoiceSession ? voice.deafened : undefined,
  )
  const participantsById = useMemo(
    () => new Map(participants.map((participant) => [participant.id, participant])),
    [participants],
  )
  const mediaItems = voice.stageMediaItems
  const mediaIds = useMemo(() => mediaItems.map((item) => item.id), [mediaItems])
  const layoutMode = resolveStageLayoutMode({
    requestedMode,
    focusedMediaId: voice.focusedMediaId,
    visibleMediaIds: mediaIds,
  })
  const focusedItem =
    layoutMode === 'focus'
      ? mediaItems.find((item) => item.id === voice.focusedMediaId) ?? null
      : null
  const fullscreenItem =
    mediaItems.find((item) => item.id === voice.focusedMediaId) ??
    defaultFullscreenItem(mediaItems)
  const popoutItem =
    mediaItems.find((item) => item.id === popout?.mediaId) ?? null

  const canInvite =
    server && channel.channel_type === 'TextChannel'
      ? canInviteToChannel(server, channel, member, auth.user?._id)
      : false
  const showInviteSlot =
    canInvite &&
    layoutMode === 'grid' &&
    !voice.stageFullscreen &&
    shouldShowVoiceInviteSlot(participants.length)

  const focusMedia = useCallback(
    (mediaId: string) => {
      const next = nextStageLayoutModeForMediaClick({
        clickedMediaId: mediaId,
        currentMode: layoutMode,
        focusedMediaId: voice.focusedMediaId,
      })
      voice.setFocusedMediaId(next.focusedMediaId)
      setRequestedMode(next.mode)
    },
    [layoutMode, voice],
  )

  const openFullscreen = useCallback(
    (mediaId: string) => {
      voice.setFocusedMediaId(mediaId)
      if (!voice.stageFullscreen) {
        voice.toggleStageFullscreen()
      }
    },
    [voice],
  )

  const toggleFullscreenFromHeader = useCallback(() => {
    if (!voice.stageFullscreen && fullscreenItem) {
      voice.setFocusedMediaId(fullscreenItem.id)
    }
    voice.toggleStageFullscreen()
  }, [fullscreenItem, voice])

  const openPopout = useCallback((mediaId: string) => {
    const childWindow = window.open(
      '',
      `syrnike13-stage-popout-${mediaId}`,
      'popup=yes,width=1280,height=720',
    )
    if (!childWindow) {
      toast.error('Браузер заблокировал отдельное окно стрима')
      return
    }
    setPopout((current) => {
      if (current && current.childWindow !== childWindow && !current.childWindow.closed) {
        current.childWindow.close()
      }
      return { mediaId, childWindow }
    })
    childWindow.focus()
  }, [])

  const closePopout = useCallback(() => {
    setPopout((current) => {
      if (current && !current.childWindow.closed) {
        current.childWindow.close()
      }
      return null
    })
  }, [])

  const renderTile = useCallback(
    (
      item: VoiceStageMediaItem,
      variant: 'grid' | 'focus' | 'strip' | 'fullscreen',
      onStreamAspectRatioChange?: (aspectRatio: number) => void,
    ) => (
      <StageMediaTile
        key={item.id}
        item={item}
        user={users[item.userId]}
        participant={participantsById.get(item.userId)}
        displayName={participantDisplayName(item.userId, users, auth.user?._id)}
        speaking={inThisVoiceCall && voice.speakingUserIds.has(item.userId)}
        variant={variant}
        onFocus={focusMedia}
        onFullscreen={openFullscreen}
        onExitFullscreen={voice.toggleStageFullscreen}
        onOpenPopout={openPopout}
        onSetSubscribed={voice.setStageMediaSubscribed}
        onStreamAspectRatioChange={onStreamAspectRatioChange}
      />
    ),
    [
      auth.user?._id,
      focusMedia,
      inThisVoiceCall,
      openFullscreen,
      openPopout,
      participantsById,
      users,
      voice.setStageMediaSubscribed,
      voice.speakingUserIds,
    ],
  )

  return (
    <div
      ref={stageRef}
      className="relative flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden bg-black text-foreground"
    >
      <div
        className={cn(
          'flex min-h-0 flex-1 flex-col overflow-hidden',
          voiceStageContentInsetClass,
        )}
      >
        {participants.length === 0 && mediaItems.length === 0 ? (
          <EmptyVoiceStage />
        ) : focusedItem ? (
          <VoiceStageFocusStage
            focusedItem={focusedItem}
            mediaItems={mediaItems}
            renderTile={renderTile}
          />
        ) : (
          <div
            className={cn(
              'mx-auto grid min-h-0 w-full max-w-[96rem] flex-1 auto-rows-min content-center items-center justify-center gap-2 overflow-y-auto sm:gap-3',
              voiceStageGridClass(mediaItems.length + (showInviteSlot ? 1 : 0)),
            )}
          >
            {mediaItems.map((item) => renderTile(item, 'grid'))}
            {showInviteSlot ? <VoiceStageInviteTile channelId={channelId} /> : null}
          </div>
        )}
      </div>

      <header
        data-voice-stage-chrome
        className={cn(
          'absolute inset-x-0 top-0 z-50 flex min-h-12 items-center gap-2 bg-gradient-to-b from-black via-black/80 to-transparent px-4 pt-1 pb-5',
          voiceStageChromeMotion(chromeVisible, 'top'),
        )}
      >
        <Volume2Icon className="size-5 shrink-0 text-muted-foreground" />
        <h1 className="min-w-0 flex-1 truncate text-sm font-semibold">{title}</h1>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="size-9 shrink-0"
          title={voice.stageFullscreen ? 'Выйти из fullscreen' : 'На весь экран'}
          disabled={!fullscreenItem}
          onClick={toggleFullscreenFromHeader}
        >
          {voice.stageFullscreen ? (
            <Minimize2Icon className="size-5" />
          ) : (
            <Maximize2Icon className="size-5" />
          )}
        </Button>
        <Button
          type="button"
          variant={chatOpen ? 'secondary' : 'ghost'}
          size="icon"
          className="size-9 shrink-0"
          title={chatOpen ? 'Скрыть чат' : 'Открыть чат'}
          aria-pressed={chatOpen}
          onClick={onToggleChat}
        >
          <MessageSquareIcon className="size-5" />
        </Button>
      </header>

      <div
        data-voice-stage-chrome
        className={cn(
          'absolute inset-x-0 bottom-0 z-50 flex justify-center px-4 pb-8 pt-2',
          voiceStageChromeMotion(chromeVisible, 'bottom'),
        )}
      >
        <VoiceStageControls
          channelId={channelId}
          inCall={inThisVoiceCall}
          connecting={connecting}
          overlay
        />
      </div>

      {voice.stageFullscreen && fullscreenItem
        ? createPortal(
            <FullscreenStageOverlay
              channelId={channelId}
              connecting={connecting}
              inCall={inThisVoiceCall}
              item={fullscreenItem}
              renderTile={renderTile}
              onExit={voice.toggleStageFullscreen}
            />,
            document.body,
          )
        : null}

      {popout && popoutItem ? (
        <VoiceStagePopout
          childWindow={popout.childWindow}
          title={`${participantDisplayName(
            popoutItem.userId,
            users,
            auth.user?._id,
          )} · ${popoutItem.kind === 'screen' ? 'Демонстрация' : 'Камера'}`}
          onClose={closePopout}
        >
          <div style={{ position: 'relative', width: '100%', height: '100%' }}>
            {popoutItem.track ? (
              <VoiceStageVideo
                track={popoutItem.track}
                fit={popoutItem.kind === 'screen' ? 'contain' : 'cover'}
                style={{
                  position: 'absolute',
                  inset: 0,
                  width: '100%',
                  height: '100%',
                  objectFit: popoutItem.kind === 'screen' ? 'contain' : 'cover',
                }}
              />
            ) : null}
          </div>
        </VoiceStagePopout>
      ) : null}
    </div>
  )
}

function FullscreenStageOverlay({
  channelId,
  connecting,
  inCall,
  item,
  renderTile,
  onExit,
}: {
  channelId: string
  connecting: boolean
  inCall: boolean
  item: VoiceStageMediaItem
  renderTile: (
    item: VoiceStageMediaItem,
    variant: 'grid' | 'focus' | 'strip' | 'fullscreen',
  ) => ReactNode
  onExit: () => void
}) {
  const { stageRef, chromeVisible } = useVoiceStageChromeVisible()

  return (
    <div
      ref={stageRef}
      className="fixed inset-0 z-[300] overflow-hidden bg-black text-white"
    >
      <div
        className={cn(
          'flex size-full items-center justify-center overflow-hidden',
          voiceStageContentInsetClass,
        )}
      >
        {renderTile(item, 'fullscreen')}
      </div>

      <div
        data-voice-stage-chrome
        className={cn(
          'absolute top-3 right-3 z-50',
          voiceStageChromeMotion(chromeVisible, 'top'),
        )}
      >
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="size-9 rounded-full bg-black/60 text-white hover:bg-black/80 hover:text-white"
          title="Выйти из fullscreen"
          onClick={onExit}
        >
          <Minimize2Icon className="size-5" />
        </Button>
      </div>

      <div
        data-voice-stage-chrome
        className={cn(
          'absolute inset-x-0 bottom-0 z-50 flex justify-center px-4 pb-8 pt-2',
          voiceStageChromeMotion(chromeVisible, 'bottom'),
        )}
      >
        <VoiceStageControls
          channelId={channelId}
          inCall={inCall}
          connecting={connecting}
          overlay
        />
      </div>
    </div>
  )
}

function EmptyVoiceStage() {
  return (
    <div className="flex min-h-[min(50vh,20rem)] flex-1 flex-col items-center justify-center gap-3 text-center">
      <p className="text-lg font-semibold">Никого нет в канале</p>
      <p className="max-w-sm text-sm text-muted-foreground">
        Подключитесь к голосу или пригласите участников на сервер.
      </p>
    </div>
  )
}
