import { MonitorXIcon, VideoOffIcon } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import { useMemo } from 'react'

import { Button } from '#/components/ui/button'
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '#/components/ui/tooltip'
import {
  cameraBroadcastIcon,
  readCameraBroadcastLabel,
  readScreenShareBroadcastSource,
  screenShareBroadcastIcon,
} from '#/features/voice/voice-broadcast-source'
import { useVoice } from '#/features/voice/voice-provider'
import { shellDivider } from '#/components/layout/shell-chrome'
import { cn } from '#/lib/utils'

function BroadcastStrip({
  sourceLabel,
  Icon,
  stopTitle,
  StopIcon,
  disabled,
  onStop,
}: {
  sourceLabel: string
  Icon: LucideIcon
  stopTitle: string
  StopIcon: LucideIcon
  disabled: boolean
  onStop: () => void
}) {
  return (
    <div className={cn('border-b px-2 py-2', shellDivider)}>
      <div className="flex items-center gap-2">
        <div
          className="flex size-8 shrink-0 items-center justify-center rounded-md bg-muted"
          title={sourceLabel}
        >
          <Icon className="size-4 text-muted-foreground" aria-hidden />
        </div>

        <p
          className="min-w-0 flex-1 truncate text-xs font-semibold leading-4 text-foreground"
          title={sourceLabel}
        >
          {sourceLabel}
        </p>

        <TooltipProvider delayDuration={300}>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                type="button"
                size="icon"
                variant="ghost"
                className="size-8 shrink-0 text-muted-foreground hover:bg-white/5 hover:text-foreground"
                disabled={disabled}
                onClick={onStop}
              >
                <StopIcon className="size-4" />
                <span className="sr-only">{stopTitle}</span>
              </Button>
            </TooltipTrigger>
            <TooltipContent side="top" sideOffset={8}>
              {stopTitle}
            </TooltipContent>
          </Tooltip>
        </TooltipProvider>
      </div>
    </div>
  )
}

function useLocalScreenShareSource() {
  const voice = useVoice()

  return useMemo(() => {
    if (!voice.screenShareEnabled) return null

    const item = voice.stageMediaItems.find(
      (entry) => entry.isLocal && entry.kind === 'screen',
    )

    return readScreenShareBroadcastSource(item?.track?.mediaStreamTrack)
  }, [voice.screenShareEnabled, voice.stageMediaItems])
}

function useLocalCameraSourceLabel() {
  const voice = useVoice()

  return useMemo(() => {
    if (!voice.cameraEnabled) return null

    const item = voice.stageMediaItems.find(
      (entry) => entry.isLocal && entry.kind === 'camera',
    )

    return readCameraBroadcastLabel(item?.track?.mediaStreamTrack)
  }, [voice.cameraEnabled, voice.stageMediaItems])
}

export function VoiceScreenShareStrip() {
  const voice = useVoice()
  const source = useLocalScreenShareSource()

  if (!source) return null

  return (
    <BroadcastStrip
      sourceLabel={source.label}
      Icon={screenShareBroadcastIcon(source.surface)}
      StopIcon={MonitorXIcon}
      stopTitle="Остановить демонстрацию"
      disabled={voice.status === 'connecting'}
      onStop={voice.toggleScreenShare}
    />
  )
}

export function VoiceCameraStrip() {
  const voice = useVoice()
  const sourceLabel = useLocalCameraSourceLabel()

  if (!sourceLabel) return null

  return (
    <BroadcastStrip
      sourceLabel={sourceLabel}
      Icon={cameraBroadcastIcon()}
      StopIcon={VideoOffIcon}
      stopTitle="Выключить камеру"
      disabled={voice.status === 'connecting'}
      onStop={voice.toggleCamera}
    />
  )
}
