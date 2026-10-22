import { MonitorXIcon, VideoOffIcon } from '#/components/icons'
import type { AppIcon } from '#/components/icons'
import { useMemo } from 'react'
import { useTranslations } from '@syrnike13/ui/i18n'

import { Button } from '@syrnike13/ui/primitives/button'
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@syrnike13/ui/primitives/tooltip'
import {
  cameraBroadcastIcon,
  readCameraBroadcastLabel,
  readDesktopScreenShareBroadcastSource,
  readScreenShareBroadcastSource,
  screenShareBroadcastIcon,
  screenShareBroadcastLabel,
} from '#/features/voice/voice-broadcast-source'
import { voiceStageMediaStreamTrack } from '#/features/voice/voice-context'
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

        <TooltipProvider delay={300}>
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  type="button"
                  size="icon"
                  variant="ghost"
                  className="size-8 shrink-0"
                  disabled={disabled}
                  onClick={onStop}
                />
              }
            >
              <StopIcon className="size-4" />
              <span className="sr-only">{stopTitle}</span>
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
      voiceStageMediaStreamTrack(item?.track),
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
  const t = useTranslations('voice')
  const voiceMedia = useVoiceMedia()
  const voiceStage = useVoiceStage()

  return useMemo(() => {
    if (!voiceMedia.cameraEnabled) return null

    const item = voiceStage.stageMediaItems.find(
      (entry) => entry.isLocal && entry.kind === 'camera',
    )

    return readCameraBroadcastLabel(
      voiceStageMediaStreamTrack(item?.track),
      t,
    )
  }, [t, voiceMedia.cameraEnabled, voiceStage.stageMediaItems])
}

export function VoiceScreenShareStrip() {
  const t = useTranslations('voice')
  const voiceSession = useVoiceSession()
  const voiceMedia = useVoiceMedia()
  const source = useLocalScreenShareSource()

  if (!source) return null

  return (
    <BroadcastStrip
      sourceLabel={screenShareBroadcastLabel(source.label, source.surface, t)}
      sourceIconDataUrl={source.appIconDataUrl}
      Icon={screenShareBroadcastIcon(source.surface)}
      StopIcon={MonitorXIcon}
      stopTitle={t('actions.stopScreenShare')}
      disabled={voiceSession.status === 'connecting'}
      onStop={voiceMedia.toggleScreenShare}
    />
  )
}

export function VoiceCameraStrip() {
  const t = useTranslations('voice')
  const voiceSession = useVoiceSession()
  const voiceMedia = useVoiceMedia()
  const sourceLabel = useLocalCameraSourceLabel()

  if (!sourceLabel) return null

  return (
    <BroadcastStrip
      sourceLabel={sourceLabel}
      Icon={cameraBroadcastIcon()}
      StopIcon={VideoOffIcon}
      stopTitle={t('actions.stopCamera')}
      disabled={voiceSession.status === 'connecting'}
      onStop={voiceMedia.toggleCamera}
    />
  )
}
