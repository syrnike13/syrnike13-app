import type { ReactNode } from 'react'
import { ChevronDownIcon } from '#/components/icons'

import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '#/components/ui/popover'
import { TooltipProvider } from '#/components/ui/tooltip'
import { VoiceControlTooltip } from '#/components/voice/voice-control-tooltip'
import { voiceStagePopoverMicSettingsClass } from '#/components/voice/voice-stage-popover-styles'
import { cn } from '#/lib/utils'

export type VoiceSplitControlSurface = 'stage' | 'panel'

type SegmentState = {
  danger?: boolean
}

const splitControlDangerMainClass =
  'bg-destructive/20 text-destructive group-hover/media:bg-destructive/30 group-hover/media:text-destructive'

const splitControlDangerChevronClass =
  'bg-destructive/20 text-destructive group-hover/media:bg-destructive/12 group-hover/media:text-destructive'

export function splitControlMainButtonClass(
  surface: VoiceSplitControlSurface,
  { danger }: SegmentState,
) {
  if (surface === 'stage') {
    return cn(
      'flex h-9 min-w-12 shrink-0 items-center justify-center rounded-l-md rounded-r-none px-2 text-white/80 transition-colors aria-disabled:cursor-not-allowed aria-disabled:opacity-50',
      danger ? splitControlDangerMainClass : 'group-hover/media:bg-white/10 group-hover/media:text-white',
    )
  }

  return cn(
    'flex size-9 shrink-0 items-center justify-center rounded-l-md rounded-r-none transition-colors aria-disabled:cursor-not-allowed aria-disabled:opacity-50',
    danger
      ? splitControlDangerMainClass
      : 'bg-transparent text-muted-foreground group-hover/media:bg-accent group-hover/media:text-foreground',
  )
}

export function splitControlChevronButtonClass(
  surface: VoiceSplitControlSurface,
  { danger }: SegmentState,
) {
  if (surface === 'stage') {
    return cn(
      'flex h-9 w-7 shrink-0 items-center justify-center rounded-r-md rounded-l-none text-white/80 transition-colors aria-disabled:cursor-not-allowed aria-disabled:opacity-50',
      danger
        ? splitControlDangerChevronClass
        : 'group-hover/media:bg-white/[0.06] group-hover/media:text-white',
    )
  }

  return cn(
    'flex h-9 w-5 shrink-0 items-center justify-center rounded-r-md rounded-l-none transition-colors aria-disabled:cursor-not-allowed aria-disabled:opacity-50',
    danger
      ? splitControlDangerChevronClass
      : 'bg-transparent text-muted-foreground group-hover/media:bg-accent group-hover/media:text-foreground',
  )
}

function SplitControlChevron({
  surface,
  disabled,
  danger,
  title,
  popoverContent,
}: {
  surface: VoiceSplitControlSurface
  disabled: boolean
  danger?: boolean
  title: string
  popoverContent: ReactNode
}) {
  const segmentState = { danger }

  return (
    <Popover>
      <VoiceControlTooltip title={title}>
        <PopoverTrigger asChild>
          <button
            type="button"
            aria-disabled={disabled}
            className={splitControlChevronButtonClass(surface, segmentState)}
          >
            <ChevronDownIcon
              className={surface === 'panel' ? 'size-3' : 'size-3.5'}
            />
          </button>
        </PopoverTrigger>
      </VoiceControlTooltip>
      <PopoverContent
        align="start"
        side="top"
        sideOffset={8}
        data-voice-stage-popover
        className={cn(
          voiceStagePopoverMicSettingsClass,
          surface === 'panel' && 'z-[200]',
        )}
        onOpenAutoFocus={(event) => event.preventDefault()}
      >
        {popoverContent}
      </PopoverContent>
    </Popover>
  )
}

export function VoiceSplitControl({
  surface,
  danger,
  disabled,
  mainTitle,
  chevronTitle,
  onMainClick,
  popoverContent,
  children,
}: {
  surface: VoiceSplitControlSurface
  danger?: boolean
  disabled?: boolean
  mainTitle: string
  chevronTitle: string
  onMainClick: () => void
  popoverContent: ReactNode
  children: ReactNode
}) {
  const segmentState = { danger }

  return (
    <TooltipProvider delayDuration={300}>
      <div className="group/media flex items-center gap-px">
        <VoiceControlTooltip title={mainTitle}>
          <button
            type="button"
            aria-disabled={disabled}
            onClick={disabled ? undefined : onMainClick}
            className={splitControlMainButtonClass(surface, segmentState)}
          >
            {children}
          </button>
        </VoiceControlTooltip>
        <SplitControlChevron
          surface={surface}
          disabled={Boolean(disabled)}
          danger={danger}
          title={chevronTitle}
          popoverContent={popoverContent}
        />
      </div>
    </TooltipProvider>
  )
}
