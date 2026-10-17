import { Volume2Icon, VolumeXIcon } from '#/components/icons'
import { useTranslations } from '@syrnike13/ui/i18n'

import { Slider } from '@syrnike13/ui/primitives/slider'
import {
  useVoiceListenerStore,
  voiceListenerStore,
  VOICE_USER_VOLUME_MAX,
} from '#/features/voice/voice-listener-store'
import { cn } from '#/lib/utils'

type VoiceStageStreamVolumeControlProps = {
  userId: string
  className?: string
}

export function VoiceStageStreamVolumeControl({
  userId,
  className,
}: VoiceStageStreamVolumeControlProps) {
  const t = useTranslations('voice')
  const muted = useVoiceListenerStore((s) => s.getStreamMuted(userId))
  const volume = useVoiceListenerStore((s) => s.getStreamVolume(userId))
  const showMutedIcon = muted || volume === 0

  function toggleMute() {
    voiceListenerStore.setStreamMuted(userId, !muted)
  }

  return (
    <div className={cn('group/stream-vol relative', className)}>
      <div
        className={cn(
          'pointer-events-none absolute bottom-full left-1/2 z-50 -translate-x-1/2 pb-2 opacity-0 transition-opacity duration-200 ease-out motion-reduce:transition-none',
          'group-hover/stream-vol:pointer-events-auto group-hover/stream-vol:opacity-100',
          'group-focus-within/stream-vol:pointer-events-auto group-focus-within/stream-vol:opacity-100',
        )}
        onPointerDown={(event) => event.stopPropagation()}
        onClick={(event) => event.stopPropagation()}
      >
        <div className="rounded-lg border border-border bg-card px-2.5 py-3 shadow-lg">
          <Slider
            orientation="vertical"
            className="h-28"
            min={0}
            max={VOICE_USER_VOLUME_MAX}
            step={0.1}
            value={[muted ? 0 : volume]}
            onValueChange={(value) => {
              const next = typeof value === 'number' ? value : value[0]
              if (next == null) return
              if (muted && next > 0) {
                voiceListenerStore.setStreamMuted(userId, false)
              }
              voiceListenerStore.setStreamVolume(userId, next)
            }}
            aria-label={t('actions.streamVolume')}
          />
        </div>
      </div>

      <button
        type="button"
        title={
          muted ? t('actions.enableStreamSound') : t('actions.disableStreamSound')
        }
        aria-pressed={muted}
        onClick={toggleMute}
        className="flex size-9 shrink-0 items-center justify-center text-on-media/60 transition-colors hover:text-on-media"
      >
        {showMutedIcon ? (
          <VolumeXIcon className="size-5" />
        ) : (
          <Volume2Icon className="size-5" />
        )}
      </button>
    </div>
  )
}
