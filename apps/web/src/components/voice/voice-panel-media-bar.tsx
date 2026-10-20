import type { ReactNode } from 'react'
import { useNavigate } from '@tanstack/react-router'
import { Effect } from 'effect'
import { useTranslations } from '@syrnike13/ui/i18n'
import {
  ActivityIcon,
  MonitorUpIcon,
  MonitorXIcon,
  SoundboardIcon,
  VideoIcon,
  VideoOffIcon,
} from '#/components/icons'

import { Spinner } from '@syrnike13/ui/primitives/spinner'
import { TooltipProvider } from '@syrnike13/ui/primitives/tooltip'
import { VoiceControlTooltip } from '#/components/voice/voice-control-tooltip'
import { useVoiceMedia } from '#/features/voice/voice-media-context'
import { useVoiceSession } from '#/features/voice/voice-session-context'
import { useVoiceStage } from '#/features/voice/voice-stage-context'
import { voiceMediaControlState } from '#/features/voice/voice-media-availability'
import { isChannelActivityStageItemId } from '#/features/activities/channel-activity-stage'
import { shellDivider } from '#/components/layout/shell-chrome'
import { uiFeatureFlags } from '#/lib/ui-feature-flags'
import { useAppRoutePrefix } from '#/features/navigation/route-prefix'
import { cn } from '#/lib/utils'

const panelMediaButtonBaseClass =
  'relative flex h-8 w-full items-center justify-center rounded-md border text-secondary-foreground transition-colors'

const panelMediaButtonDisabledClass = 'cursor-not-allowed opacity-45'

const panelMediaButtonIdleClass =
  'border-secondary-foreground/5 bg-secondary-foreground/8 hover:border-secondary-foreground/5 hover:bg-secondary-foreground/12'

const panelMediaButtonActiveClass =
  'border-chart-3/5 bg-chart-3/20 hover:border-chart-3/5 hover:bg-chart-3/30'

const panelMediaButtonSoonClass =
  'cursor-not-allowed border-dashed border-secondary-foreground/5 bg-secondary-foreground/4 text-secondary-foreground/35'

function PanelMediaButton({
  title,
  active,
  disabled,
  onClick,
  children,
}: {
  title: string
  active?: boolean
  disabled?: boolean
  onClick?: () => void
  children: ReactNode
}) {
  return (
    <VoiceControlTooltip title={title} wrapperClassName="flex min-w-0 flex-1">
      <button
        type="button"
        aria-label={title}
        aria-pressed={active}
        aria-disabled={disabled}
        onClick={disabled ? undefined : onClick}
        className={cn(
          panelMediaButtonBaseClass,
          active ? panelMediaButtonActiveClass : panelMediaButtonIdleClass,
          disabled && panelMediaButtonDisabledClass,
        )}
      >
        {children}
      </button>
    </VoiceControlTooltip>
  )
}

function PanelMediaButtonSoon({
  title,
  children,
}: {
  title: string
  children: ReactNode
}) {
  const t = useTranslations('voice')

  return (
    <VoiceControlTooltip
      title={title}
      wrapperClassName="flex min-w-0 flex-1"
      content={
        <>
          <p className="font-medium">{title}</p>
          <p className="text-xs text-muted-foreground">{t('actions.soon')}</p>
        </>
      }
      contentClassName="text-center"
    >
      <button
        type="button"
        aria-label={title}
        aria-disabled
        className={cn(panelMediaButtonBaseClass, panelMediaButtonSoonClass)}
      >
        {children}
      </button>
    </VoiceControlTooltip>
  )
}

export function VoicePanelMediaBar() {
  const t = useTranslations('voice')
  const navigate = useNavigate()
  const routePrefix = useAppRoutePrefix()
  const voiceSession = useVoiceSession()
  const voiceMedia = useVoiceMedia()
  const voiceStage = useVoiceStage()
  const connecting = voiceSession.status === 'connecting'
  const cameraOn = voiceMedia.cameraEnabled
  const sharingScreen = voiceMedia.screenShareEnabled
  const screenShareStarting = voiceMedia.screenShareStarting
  const cameraControl = voiceMediaControlState({
    availability: voiceMedia.mediaAvailability.camera,
    active: cameraOn,
    connecting,
    activeTitle: t('actions.stopCamera'),
    inactiveTitle: t('actions.startCamera'),
  })
  const screenShareControl = voiceMediaControlState({
    availability: voiceMedia.mediaAvailability.screenShare,
    active: sharingScreen,
    connecting,
    busy: screenShareStarting,
    activeTitle: t('actions.stopScreenShare'),
    inactiveTitle: t('actions.startScreenShare'),
    busyTitle: t('actions.screenShareStarting'),
  })

  return (
    <TooltipProvider delay={300}>
      <div className={cn('flex gap-1.5 border-b px-2 pb-2 pt-1', shellDivider)}>
        <PanelMediaButton
          title={cameraControl.title}
          active={cameraOn}
          disabled={cameraControl.disabled}
          onClick={voiceMedia.toggleCamera}
        >
          {cameraOn ? (
            <VideoIcon className="size-4.5" />
          ) : (
            <VideoOffIcon className="size-4.5" />
          )}
        </PanelMediaButton>

        <PanelMediaButton
          title={screenShareControl.title}
          active={sharingScreen || screenShareStarting}
          disabled={screenShareControl.disabled}
          onClick={voiceMedia.toggleScreenShare}
        >
          {screenShareStarting ? (
            <Spinner className="size-4.5" />
          ) : sharingScreen ? (
            <MonitorXIcon className="size-4.5" />
          ) : (
            <MonitorUpIcon className="size-4.5" />
          )}
        </PanelMediaButton>

        {uiFeatureFlags.channelActivities ? (
          <PanelMediaButton
            title={t('actions.activities')}
            active={
              voiceStage.activityLauncherOpen ||
              isChannelActivityStageItemId(voiceStage.focusedMediaId)
            }
            disabled={voiceSession.status !== 'connected'}
            onClick={() => {
              if (voiceStage.activityLauncherOpen) {
                voiceStage.setActivityLauncherOpen(false)
                return
              }
              const channelId = voiceSession.channelId
              if (!channelId) return
              Effect.runFork(
                Effect.tryPromise({
                  try: () =>
                    navigate({
                      to:
                        routePrefix === '/m'
                          ? '/m/c/$channelId'
                          : '/c/$channelId',
                      params: { channelId },
                      search: { m: undefined },
                    }),
                  catch: (cause) => cause,
                }).pipe(
                  Effect.tap(() =>
                    Effect.sync(() => {
                      voiceStage.setActivityLauncherOpen(true)
                    }),
                  ),
                  Effect.ignore,
                ),
              )
            }}
          >
            <ActivityIcon className="size-4.5" />
          </PanelMediaButton>
        ) : null}

        <PanelMediaButtonSoon title={t('actions.soundboard')}>
          <SoundboardIcon className="size-4.5" />
        </PanelMediaButtonSoon>
      </div>
    </TooltipProvider>
  )
}
