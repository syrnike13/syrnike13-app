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

import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '#/components/ui/tooltip'
import { useVoice } from '#/features/voice/voice-context'
import { shellDivider } from '#/components/layout/shell-chrome'
import { cn } from '#/lib/utils'

const panelMediaButtonBaseClass =
  'relative flex h-8 flex-1 items-center justify-center rounded-md border text-secondary-foreground transition-colors'

const panelMediaButtonDisabledClass =
  'pointer-events-none opacity-45'

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
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          title={title}
          disabled={disabled}
          onClick={onClick}
          className={cn(
            panelMediaButtonBaseClass,
            active ? panelMediaButtonActiveClass : panelMediaButtonIdleClass,
            disabled && panelMediaButtonDisabledClass,
          )}
        >
          {children}
        </button>
      </TooltipTrigger>
      <TooltipContent side="top" sideOffset={8}>
        {title}
      </TooltipContent>
    </Tooltip>
  )
}

function PanelMediaButtonSoon({ title, children }: { title: string; children: ReactNode }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className="flex min-w-0 flex-1">
          <button
            type="button"
            disabled
            aria-disabled
            title={title}
            className={cn(panelMediaButtonBaseClass, panelMediaButtonSoonClass, 'w-full')}
          >
            {children}
          </button>
        </span>
      </TooltipTrigger>
      <TooltipContent side="top" sideOffset={8} className="text-center">
        <p className="font-medium">{title}</p>
        <p className="text-xs text-muted-foreground">Скоро</p>
      </TooltipContent>
    </Tooltip>
  )
}

export function VoicePanelMediaBar() {
  const voice = useVoice()
  const connecting = voice.status === 'connecting'
  const cameraOn = voice.cameraEnabled
  const sharingScreen = voice.screenShareEnabled
  const screenShareStarting = voice.screenShareStarting

  return (
    <TooltipProvider delayDuration={300}>
      <div className={cn('flex gap-1.5 border-b px-2 pb-2 pt-1', shellDivider)}>
        <PanelMediaButton
          title={cameraOn ? 'Выключить камеру' : 'Включить камеру'}
          active={cameraOn}
          disabled={connecting}
          onClick={voice.toggleCamera}
        >
          {cameraOn ? (
            <VideoIcon className="size-[1.125rem]" />
          ) : (
            <VideoOffIcon className="size-[1.125rem]" />
          )}
        </PanelMediaButton>

        <PanelMediaButton
          title={
            screenShareStarting
              ? 'Демонстрация запускается'
              : sharingScreen
                ? 'Остановить демонстрацию'
                : 'Демонстрация экрана'
          }
          active={sharingScreen || screenShareStarting}
          disabled={connecting || screenShareStarting}
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
