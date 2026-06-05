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
  voiceStageGridClass,
} from '#/components/voice/voice-stage-layout'
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

  const showInviteSlot =
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
    (item: VoiceStageMediaItem, variant: 'grid' | 'focus' | 'strip' | 'fullscreen') => (
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
    <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-[#1e1f22] text-foreground">
      <header className="flex h-12 shrink-0 items-center gap-2 border-b border-white/10 px-4">
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

      <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
        {participants.length === 0 && mediaItems.length === 0 ? (
          <EmptyVoiceStage />
        ) : focusedItem ? (
          <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-hidden p-3 sm:p-4">
            <div className="flex min-h-0 flex-1 items-center justify-center overflow-hidden">
              {renderTile(focusedItem, 'focus')}
            </div>
            {mediaItems.length > 1 ? (
              <div className="flex h-28 shrink-0 items-center justify-center gap-2 overflow-x-auto pb-1 sm:h-32">
                {mediaItems
                  .filter((item) => item.id !== focusedItem.id)
                  .map((item) => renderTile(item, 'strip'))}
              </div>
            ) : null}
          </div>
        ) : (
          <div
            className={cn(
              'mx-auto grid min-h-0 w-full max-w-[96rem] flex-1 auto-rows-min content-center items-center justify-center gap-2 overflow-y-auto p-2 sm:gap-3 sm:p-3',
              voiceStageGridClass(mediaItems.length + (showInviteSlot ? 1 : 0)),
            )}
          >
            {mediaItems.map((item) => renderTile(item, 'grid'))}
            {showInviteSlot ? <VoiceStageInviteTile channelId={channelId} /> : null}
          </div>
        )}

        <VoiceStageControls
          channelId={channelId}
          inCall={inThisVoiceCall}
          connecting={connecting}
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
  return (
    <div className="fixed inset-0 z-[300] flex flex-col bg-black text-white">
      <div className="pointer-events-none absolute top-3 right-3 z-10">
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="pointer-events-auto size-9 rounded-full bg-black/60 text-white hover:bg-black/80 hover:text-white"
          title="Выйти из fullscreen"
          onClick={onExit}
        >
          <Minimize2Icon className="size-5" />
        </Button>
      </div>
      <div className="min-h-0 flex-1 overflow-hidden p-0">
        <div className="flex size-full items-center justify-center overflow-hidden">
          {renderTile(item, 'fullscreen')}
        </div>
      </div>
      <div className="shrink-0">
        <VoiceStageControls
          channelId={channelId}
          inCall={inCall}
          connecting={connecting}
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
