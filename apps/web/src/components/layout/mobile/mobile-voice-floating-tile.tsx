import { useNavigate } from '@tanstack/react-router'
import {
  HeadphonesIcon,
  MicOffIcon,
  MonitorUpIcon,
  VideoIcon,
} from '#/components/icons'
import { VoiceChannelIcon } from '#/components/icons/voice-channel-icon'

import { useMobileVoiceChannelDrawer } from '#/features/navigation/mobile-voice-channel-drawer-context'
import { getChannelLabel } from '#/features/sync/channel-label'
import { useSyncStore } from '#/features/sync/sync-store'
import { useAuth } from '#/features/auth/auth-context'
import { useVoiceMedia } from '#/features/voice/voice-media-context'
import { useVoiceSession } from '#/features/voice/voice-session-context'
import { useVoiceStage } from '#/features/voice/voice-stage-context'
import {
  isVoiceConnectionReady,
  isMicVisuallyMuted,
} from '#/features/voice/voice-mic-status'
import { useFloatingCornerAnchor } from '#/hooks/use-floating-corner-anchor'
import { isServerVoiceChannel } from '#/lib/channel-voice'
import {
  floatingCornerPositionClass,
  MOBILE_VOICE_FLOATING_TILE_SIZE_PX,
  MOBILE_VOICE_TILE_CORNER_STORAGE_KEY,
} from '#/lib/floating-corner'
import { cn } from '#/lib/utils'

/**
 * Компактная плавающая плитка голосового канала для мобильной зоны `/m`.
 *
 * Заменяет широкую панель VoiceConnectionStrip + VoicePanelMediaBar в списке
 * каналов. Перетаскивается и прилипает к углу экрана; тап открывает drawer.
 */
export function MobileVoiceFloatingTile() {
  const auth = useAuth()
  const voiceSession = useVoiceSession()
  const voiceMedia = useVoiceMedia()
  const voiceStage = useVoiceStage()
  const navigate = useNavigate()
  const { channelId: drawerChannelId, openVoiceChannelDrawer } =
    useMobileVoiceChannelDrawer()
  const channel = useSyncStore((s) =>
    voiceSession.channelId ? s.channels[voiceSession.channelId] : undefined,
  )
  const server = useSyncStore((s) =>
    channel?.channel_type === 'TextChannel' ? s.servers[channel.server] : undefined,
  )
  const users = useSyncStore((s) => s.users)

  const inVoiceSession =
    voiceSession.channelId != null &&
    (voiceSession.status === 'connected' ||
      voiceSession.status === 'connecting')
  const connected = isVoiceConnectionReady({
    status: voiceSession.status,
    localVoiceReady: voiceSession.localVoiceReady,
  })

  const {
    corner,
    dragPoint,
    isDragging,
    onPointerDown,
    onPointerMove,
    onPointerUp,
    onPointerCancel,
    consumeSuppressedClick,
  } = useFloatingCornerAnchor(MOBILE_VOICE_TILE_CORNER_STORAGE_KEY)

  if (!inVoiceSession || !voiceSession.channelId || voiceStage.stageFullscreen) {
    return null
  }

  if (drawerChannelId) {
    return null
  }

  const channelLabel =
    channel && auth.user
      ? getChannelLabel(channel, users, auth.user._id)
      : 'Голосовой канал'
  const title = server ? `${server.name} / ${channelLabel}` : channelLabel

  const micMuted = isMicVisuallyMuted({
    inVoiceSession,
    micEnabled: voiceSession.micEnabled,
    micPublishing: voiceSession.micPublishing,
  })
  const soundOff = voiceSession.deafened
  const cameraOn = voiceMedia.cameraEnabled
  const sharingScreen = voiceMedia.screenShareEnabled

  const half = MOBILE_VOICE_FLOATING_TILE_SIZE_PX / 2

  function handleOpenDrawer() {
    if (!voiceSession.channelId) return
    if (channel && isServerVoiceChannel(channel)) {
      openVoiceChannelDrawer(voiceSession.channelId)
      return
    }
    void navigate({
      to: '/m/c/$channelId',
      params: { channelId: voiceSession.channelId },
      search: { m: undefined },
    })
  }

  return (
    <div
      className={cn(
        'pointer-events-none fixed z-[60]',
        !isDragging && floatingCornerPositionClass(corner),
      )}
      style={
        dragPoint
          ? {
              left: dragPoint.x - half,
              top: dragPoint.y - half,
            }
          : undefined
      }
    >
      <button
        type="button"
        title={title}
        aria-label={`Голос: ${title}. Перетащите в угол или нажмите для управления`}
        className={cn(
          'gradient-surface-floating pointer-events-auto relative flex size-14 touch-none items-center justify-center rounded-2xl bg-card shadow-lg ring-1 ring-shell-divider transition-shadow active:shadow-md',
          isDragging && 'scale-105 shadow-xl ring-chart-3/40',
          !connected && 'animate-pulse',
        )}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerCancel}
        onClick={() => {
          if (consumeSuppressedClick()) return
          handleOpenDrawer()
        }}
      >
        {channel && isServerVoiceChannel(channel) ? (
          <VoiceChannelIcon
            channel={channel}
            server={server}
            className={cn(
              'size-6',
              connected ? 'text-chart-3' : 'text-chart-2',
            )}
          />
        ) : (
          <HeadphonesIcon
            className={cn(
              'size-6',
              connected ? 'text-chart-3' : 'text-chart-2',
            )}
            aria-hidden
          />
        )}

        <span
          className={cn(
            'absolute top-1.5 right-1.5 size-2 rounded-full ring-2 ring-card',
            connected ? 'bg-chart-3' : 'bg-chart-2',
          )}
          aria-hidden
        />

        {(micMuted || soundOff || cameraOn || sharingScreen) && (
          <span className="absolute bottom-1 left-1 flex items-center gap-0.5">
            {micMuted ? (
              <span className="flex size-4 items-center justify-center rounded-full bg-destructive/90 text-white">
                <MicOffIcon className="size-2.5" aria-hidden />
              </span>
            ) : null}
            {soundOff ? (
              <span
                className="flex size-4 items-center justify-center rounded-full bg-muted text-[10px] font-bold text-foreground"
                title="Звук выключен"
              >
                !
              </span>
            ) : null}
            {cameraOn ? (
              <span className="flex size-4 items-center justify-center rounded-full bg-chart-3/90 text-white">
                <VideoIcon className="size-2.5" aria-hidden />
              </span>
            ) : null}
            {sharingScreen ? (
              <span className="flex size-4 items-center justify-center rounded-full bg-chart-3/90 text-white">
                <MonitorUpIcon className="size-2.5" aria-hidden />
              </span>
            ) : null}
          </span>
        )}
      </button>
    </div>
  )
}
