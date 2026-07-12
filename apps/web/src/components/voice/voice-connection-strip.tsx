import { Link } from '@tanstack/react-router'
import { PhoneOffIcon, SignalIcon } from '#/components/icons'

import { Button } from '#/components/ui/button'
import { Popover, PopoverTrigger } from '#/components/ui/popover'
import { VoicePingPopoverContent } from '#/components/voice/voice-ping-popover'
import { formatVoicePingLabel } from '#/features/voice/voice-ping'
import { useAuth } from '#/features/auth/auth-context'
import { useAppRoutePrefix } from '#/features/navigation/route-prefix'
import { getChannelLabel } from '#/features/sync/channel-label'
import { useSyncStore } from '#/features/sync/sync-store'
import {
  isVoiceConnectionReady,
  voiceConnectionPhaseLabel,
} from '#/features/voice/voice-mic-status'
import { useVoiceSession } from '#/features/voice/voice-session-context'
import { useVoiceTelemetry } from '#/features/voice/voice-telemetry-context'
import { serverChannelServerId } from '#/lib/channel-voice'
import { cn } from '#/lib/utils'

const VOICE_STATUS_CONNECTED = {
  accent: 'text-chart-3',
  icon: 'text-chart-3',
  iconBg: 'bg-chart-3/15',
} as const

const VOICE_STATUS_CONNECTING = {
  accent: 'text-chart-2',
  icon: 'text-chart-2',
  iconBg: 'bg-chart-2/15',
} as const

const VOICE_STATUS_FAILED = {
  accent: 'text-destructive',
  icon: 'text-destructive',
  iconBg: 'bg-destructive/15',
} as const

export function VoiceConnectionStrip() {
  const auth = useAuth()
  const voice = useVoiceSession()
  const voiceTelemetry = useVoiceTelemetry()
  const prefix = useAppRoutePrefix()
  const channel = useSyncStore((s) =>
    voice.channelId ? s.channels[voice.channelId] : undefined,
  )
  const server = useSyncStore((s) => {
    const serverId = serverChannelServerId(channel)
    return serverId ? s.servers[serverId] : undefined
  })
  const users = useSyncStore((s) => s.users)

  if (voice.status === 'idle' || !voice.channelId) return null

  const channelLabel =
    channel && auth.user
      ? getChannelLabel(channel, users, auth.user._id)
      : 'Голосовой канал'

  const locationLabel = server
    ? `${server.name} / ${channelLabel}`
    : channelLabel

  const connected = isVoiceConnectionReady({
    status: voice.status,
    localVoiceReady: voice.localVoiceReady,
  })
  const status =
    voice.connectionPhase === 'failed'
      ? VOICE_STATUS_FAILED
      : connected
        ? VOICE_STATUS_CONNECTED
        : VOICE_STATUS_CONNECTING
  const statusLabel = voiceConnectionPhaseLabel(voice.connectionPhase)
  const pingLabel = formatVoicePingLabel(
    voiceTelemetry.voicePingMs,
    connected,
  )

  return (
    <div
      className={cn('px-2 pt-2 pb-1', !connected && 'animate-pulse')}
    >
      <div className="flex items-center gap-2">
        {connected ? (
          <Popover>
            <PopoverTrigger asChild>
              <button
                type="button"
                className={cn(
                  'flex size-8 shrink-0 cursor-pointer items-center justify-center rounded-md outline-none transition-colors hover:brightness-110 focus-visible:ring-2 focus-visible:ring-ring',
                  status.iconBg,
                )}
                title={pingLabel}
                aria-label={`${pingLabel}. Открыть статистику подключения`}
              >
                <SignalIcon
                  className={cn('size-4', status.icon)}
                  aria-hidden
                />
              </button>
            </PopoverTrigger>
            <VoicePingPopoverContent />
          </Popover>
        ) : (
          <div
            className={cn(
              'flex size-8 shrink-0 cursor-default items-center justify-center rounded-md',
              status.iconBg,
            )}
            title={pingLabel}
          >
            <SignalIcon className={cn('size-4', status.icon)} aria-hidden />
          </div>
        )}

        <div className="min-w-0 flex-1">
          <p className={cn('text-xs font-semibold leading-4', status.accent)}>
            {statusLabel}
          </p>
          <Link
            to={prefix === '/m' ? '/m/c/$channelId' : '/app/c/$channelId'}
            params={{ channelId: voice.channelId }}
            search={{ m: undefined }}
            className="block truncate text-xs leading-4 text-muted-foreground hover:text-foreground hover:underline"
            title={locationLabel}
          >
            {locationLabel}
          </Link>
        </div>

        <Button
          type="button"
          size="icon"
          variant="ghost"
          className="size-8 shrink-0 text-muted-foreground hover:bg-destructive/15 hover:text-destructive"
          title="Отключиться от голоса"
          onClick={voice.leave}
        >
          <PhoneOffIcon className="size-4" />
          <span className="sr-only">Отключиться</span>
        </Button>
      </div>
    </div>
  )
}
