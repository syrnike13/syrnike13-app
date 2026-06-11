import type { ReactNode } from 'react'
import {
  ActivityIcon,
  Loader2Icon,
  MonitorUpIcon,
  MonitorXIcon,
  SoundboardIcon,
  VideoIcon,
  VideoOffIcon,
} from '#/components/icons'

import { TooltipProvider } from '#/components/ui/tooltip'
import { VoiceControlTooltip } from '#/components/voice/voice-control-tooltip'
import { useVoice } from '#/features/voice/voice-context'
import { voiceMediaControlState } from '#/features/voice/voice-media-availability'
import { shellDivider } from '#/components/layout/shell-chrome'
import { cn } from '#/lib/utils'

const panelMediaButtonBaseClass =
  'relative flex h-8 w-full items-center justify-center rounded-md border text-secondary-foreground transition-colors'

const panelMediaButtonDisabledClass =
  'cursor-not-allowed opacity-45'

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

function PanelMediaButtonSoon({ title, children }: { title: string; children: ReactNode }) {
  return (
    <VoiceControlTooltip
      title={title}
      wrapperClassName="flex min-w-0 flex-1"
      content={
        <>
          <p className="font-medium">{title}</p>
          <p className="text-xs text-muted-foreground">Скоро</p>
        </>
      }
      contentClassName="text-center"
    >
      <button
        type="button"
        aria-disabled
        className={cn(panelMediaButtonBaseClass, panelMediaButtonSoonClass)}
      >
        {children}
      </button>
    </VoiceControlTooltip>
  )
}

export function VoicePanelMediaBar() {
  const voice = useVoice()
  const connecting = voice.status === 'connecting'
  const cameraOn = voice.cameraEnabled
  const sharingScreen = voice.screenShareEnabled
  const screenShareStarting = voice.screenShareStarting
  const cameraControl = voiceMediaControlState({
    availability: voice.mediaAvailability.camera,
    active: cameraOn,
    connecting,
    activeTitle: 'Выключить камеру',
    inactiveTitle: 'Включить камеру',
  })
  const screenShareControl = voiceMediaControlState({
    availability: voice.mediaAvailability.screenShare,
    active: sharingScreen,
    connecting,
    busy: screenShareStarting,
    activeTitle: 'Остановить демонстрацию',
    inactiveTitle: 'Демонстрация экрана',
    busyTitle: 'Демонстрация запускается',
  })

  return (
    <TooltipProvider delayDuration={300}>
      <div className={cn('flex gap-1.5 border-b px-2 pb-2 pt-1', shellDivider)}>
        <PanelMediaButton
          title={cameraControl.title}
          active={cameraOn}
          disabled={cameraControl.disabled}
          onClick={voice.toggleCamera}
        >
          {cameraOn ? (
            <VideoIcon className="size-[1.125rem]" />
          ) : (
            <VideoOffIcon className="size-[1.125rem]" />
          )}
        </PanelMediaButton>

        <PanelMediaButton
          title={screenShareControl.title}
          active={sharingScreen || screenShareStarting}
          disabled={screenShareControl.disabled}
          onClick={voice.toggleScreenShare}
        >
          {screenShareStarting ? (
            <Loader2Icon className="size-[1.125rem] animate-spin" />
          ) : sharingScreen ? (
            <MonitorXIcon className="size-[1.125rem]" />
          ) : (
            <MonitorUpIcon className="size-[1.125rem]" />
          )}
        </PanelMediaButton>

        <PanelMediaButtonSoon title="Активность">
          <ActivityIcon className="size-[1.125rem]" />
        </PanelMediaButtonSoon>

        <PanelMediaButtonSoon title="Саундбар">
          <SoundboardIcon className="size-[1.125rem]" />
        </PanelMediaButtonSoon>
      </div>
    </TooltipProvider>
  )
}
