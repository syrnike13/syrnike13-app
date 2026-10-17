import { Link } from '@tanstack/react-router'
import { useTranslations } from '@syrnike13/ui/i18n'
import { PhoneOffIcon, SignalIcon } from '#/components/icons'

import { Button } from '@syrnike13/ui/primitives/button'
import { Popover, PopoverTrigger } from '@syrnike13/ui/primitives/popover'
import { TooltipProvider } from '@syrnike13/ui/primitives/tooltip'
import { VoiceControlTooltip } from '#/components/voice/voice-control-tooltip'
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

/** Компактная подсказка пинга, как в Discord. */
const pingTooltipClass =
  'px-2 py-1 text-xs leading-none font-medium'

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
  const t = useTranslations('voice')
  const ts = useTranslations('voice.status')
  const tChat = useTranslations('chat')
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
      ? getChannelLabel(channel, users, auth.user._id, tChat)
      : t('channel')

  const locationLabel = server
    ? `${channelLabel} / ${server.name}`
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
  const statusIconBg =
    voice.connectionPhase === 'failed'
      ? 'bg-destructive/15'
      : connected
        ? 'bg-chart-3/15'
        : 'bg-chart-2/15'
  const statusLabel = voiceConnectionPhaseLabel(voice.connectionPhase, ts)
  const pingLabel = formatVoicePingLabel(
    voiceTelemetry.voicePingMs,
    connected,
    t,
  )

  return (
    <TooltipProvider delay={200}>
    <div
      className={cn('px-2 pt-2 pb-1', !connected && 'animate-pulse')}
    >
      <div className="flex items-center gap-2">
        {connected ? (
          <Popover>
            <VoiceControlTooltip
            title={pingLabel}
            contentClassName={pingTooltipClass}
          >
              <PopoverTrigger render={<button
                  type="button"
                  className={cn(
                    'flex size-8 shrink-0 cursor-pointer items-center justify-center rounded-md outline-none transition-colors hover:brightness-110 focus-visible:ring-2 focus-visible:ring-ring',
                    statusIconBg,
                  )}
                  aria-label={`${pingLabel}. ${t('openStats')}`} />}>
                  <SignalIcon
                    className={cn('size-4', status.icon)}
                    aria-hidden
                  />
                </PopoverTrigger>
            </VoiceControlTooltip>
            <VoicePingPopoverContent />
          </Popover>
        ) : (
          <VoiceControlTooltip
            title={pingLabel}
            contentClassName={pingTooltipClass}
          >
            <div
              className={cn(
                'flex size-8 shrink-0 cursor-default items-center justify-center rounded-md',
                status.iconBg,
              )}
              aria-label={pingLabel}
            >
              <SignalIcon className={cn('size-4', status.icon)} aria-hidden />
            </div>
          </VoiceControlTooltip>
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

        <VoiceControlTooltip title={t('disconnect')}>
        <Button
          type="button"
          size="icon"
          variant="destructive"
          className="size-8 shrink-0"
          aria-label={t('disconnect')}
          onClick={voice.leave}
        >
          <PhoneOffIcon className="size-4" />
        </Button>
        </VoiceControlTooltip>
      </div>
    </div>
    </TooltipProvider>
  )
}
