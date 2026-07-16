import { MonitorXIcon, VideoOffIcon } from '#/components/icons'
import type { AppIcon } from '#/components/icons'
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
  readDesktopScreenShareBroadcastSource,
  readScreenShareBroadcastSource,
  screenShareBroadcastIcon,
} from '#/features/voice/voice-broadcast-source'
import { useVoiceMedia } from '#/features/voice/voice-media-context'
import { useVoiceSession } from '#/features/voice/voice-session-context'
import { useVoiceStage } from '#/features/voice/voice-stage-context'
import { shellDivider } from '#/components/layout/shell-chrome'
import { cn } from '#/lib/utils'
import { usePlatform } from '#/platform/use-platform'

function BroadcastStrip({
  sourceLabel,
  sourceIconDataUrl,
  Icon,
  stopTitle,
  StopIcon,
  disabled,
  onStop,
}: {
  sourceLabel: string
  sourceIconDataUrl?: string | null
  Icon: AppIcon
  stopTitle: string
  StopIcon: AppIcon
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
          {sourceIconDataUrl ? (
            <img
              src={sourceIconDataUrl}
              alt=""
              className="size-5 object-contain"
              draggable={false}
            />
          ) : (
            <Icon className="size-4 text-muted-foreground" aria-hidden />
          )}
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
  const voiceMedia = useVoiceMedia()
  const voiceStage = useVoiceStage()
  const { desktop } = usePlatform()

  return useMemo(() => {
    if (!voiceMedia.screenShareEnabled) return null

    const item = voiceStage.stageMediaItems.find(
      (entry) => entry.isLocal && entry.kind === 'screen',
    )

    const trackSource = readScreenShareBroadcastSource(
      item?.track?.mediaStreamTrack,
    )
    if (!desktop) {
      return trackSource
    }

    return readDesktopScreenShareBroadcastSource() ?? trackSource
  }, [
    desktop,
    voiceMedia.screenShareEnabled,
    voiceStage.stageMediaItems,
  ])
}

function useLocalCameraSourceLabel() {
  const voiceMedia = useVoiceMedia()
  const voiceStage = useVoiceStage()

  return useMemo(() => {
    if (!voiceMedia.cameraEnabled) return null

    const item = voiceStage.stageMediaItems.find(
      (entry) => entry.isLocal && entry.kind === 'camera',
    )

    return readCameraBroadcastLabel(item?.track?.mediaStreamTrack)
  }, [voiceMedia.cameraEnabled, voiceStage.stageMediaItems])
}

export function VoiceScreenShareStrip() {
  const voiceSession = useVoiceSession()
  const voiceMedia = useVoiceMedia()
  const source = useLocalScreenShareSource()

  if (!source) return null

  return (
    <BroadcastStrip
      sourceLabel={source.label}
      sourceIconDataUrl={source.appIconDataUrl}
      Icon={screenShareBroadcastIcon(source.surface)}
      StopIcon={MonitorXIcon}
      stopTitle="Остановить демонстрацию"
      disabled={voiceSession.status === 'connecting'}
      onStop={voiceMedia.toggleScreenShare}
    />
  )
}

export function VoiceCameraStrip() {
  const voiceSession = useVoiceSession()
  const voiceMedia = useVoiceMedia()
  const sourceLabel = useLocalCameraSourceLabel()

  if (!sourceLabel) return null

  return (
    <BroadcastStrip
      sourceLabel={sourceLabel}
      Icon={cameraBroadcastIcon()}
      StopIcon={VideoOffIcon}
      stopTitle="Выключить камеру"
      disabled={voiceSession.status === 'connecting'}
      onStop={voiceMedia.toggleCamera}
    />
  )
}
