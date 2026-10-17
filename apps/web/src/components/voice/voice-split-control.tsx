import type { ReactNode } from 'react'
import { ChevronDownIcon } from '#/components/icons'

import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@syrnike13/ui/primitives/popover'
import { TooltipProvider } from '@syrnike13/ui/primitives/tooltip'
import { VoiceControlTooltip } from '#/components/voice/voice-control-tooltip'
import { voiceStagePopoverMicSettingsClass } from '#/components/voice/voice-stage-popover-styles'
import { cn } from '#/lib/utils'

export type VoiceSplitControlSurface = 'stage' | 'panel'

type SegmentState = {
  danger?: boolean
  success?: boolean
}

const splitControlSuccessMainClass =
  'bg-chart-3/20 text-chart-3 group-hover/media:bg-chart-3/30 group-hover/media:text-chart-3'


export const splitControlDangerMainClass =
  'bg-destructive/20 text-destructive group-hover/media:bg-destructive/30 group-hover/media:text-destructive'

export const splitControlDangerChevronClass =
  'bg-destructive/20 text-destructive group-hover/media:bg-destructive/12 group-hover/media:text-destructive'

export const splitControlDangerStandaloneClass =
  'bg-destructive/20 text-destructive hover:bg-destructive/30 hover:text-destructive'

export function splitControlMainButtonClass(
  surface: VoiceSplitControlSurface,
  { danger, success }: SegmentState,
) {
  if (surface === 'stage') {
    return cn(
      'flex h-9 min-w-12 shrink-0 items-center justify-center rounded-l-md rounded-r-none px-2 text-muted-foreground transition-colors aria-disabled:cursor-not-allowed aria-disabled:opacity-50',
      danger
        ? splitControlDangerMainClass
        : success
          ? splitControlSuccessMainClass
          : 'group-hover/media:bg-accent group-hover/media:text-foreground',
    )
  }

  return cn(
    'flex size-9 shrink-0 items-center justify-center rounded-l-md rounded-r-none transition-colors aria-disabled:cursor-not-allowed aria-disabled:opacity-50',
    danger
      ? splitControlDangerMainClass
      : success
        ? splitControlSuccessMainClass
        : 'bg-transparent text-muted-foreground group-hover/media:bg-accent group-hover/media:text-foreground',
  )
}

function SplitControlChevron({
  surface,
  disabled,
  danger,
  success,
  title,
  popoverContent,
}: {
  surface: VoiceSplitControlSurface
  disabled: boolean
  danger?: boolean
  success?: boolean
  title: string
  popoverContent: ReactNode
}) {
  const chevronClass =
    surface === 'stage'
      ? cn(
          'flex h-9 w-7 shrink-0 items-center justify-center rounded-r-md rounded-l-none text-muted-foreground transition-colors aria-disabled:cursor-not-allowed aria-disabled:opacity-50',
          danger
            ? 'bg-destructive/20 text-destructive group-hover/media:bg-destructive/12 group-hover/media:text-destructive'
            : success
              ? 'bg-chart-3/20 text-chart-3 group-hover/media:bg-chart-3/12 group-hover/media:text-chart-3'
              : 'group-hover/media:bg-accent group-hover/media:text-foreground',
        )
      : cn(
          'flex h-9 w-5 shrink-0 items-center justify-center rounded-r-md rounded-l-none transition-colors aria-disabled:cursor-not-allowed aria-disabled:opacity-50',
          danger
            ? 'bg-destructive/20 text-destructive group-hover/media:bg-destructive/12 group-hover/media:text-destructive'
            : success
              ? 'bg-chart-3/20 text-chart-3 group-hover/media:bg-chart-3/12 group-hover/media:text-chart-3'
              : 'bg-transparent text-muted-foreground group-hover/media:bg-accent group-hover/media:text-foreground',
        )

  return (
    <Popover>
      <VoiceControlTooltip title={title}>
        <PopoverTrigger render={<button
            type="button"
            aria-label={title}
            aria-disabled={disabled}
            className={chevronClass} />}>
            <ChevronDownIcon
              className={surface === 'panel' ? 'size-3' : 'size-3.5'}
            />
          </PopoverTrigger>
      </VoiceControlTooltip>
      <PopoverContent
        align="start"
        side="top"
        sideOffset={8}
        data-voice-stage-popover
        className={cn(
          // eslint-disable-next-line shadcn/require-static-classes -- shared voice popover class
          voiceStagePopoverMicSettingsClass,
          surface === 'panel' && 'z-200',
        )}
      >
        {popoverContent}
      </PopoverContent>
    </Popover>
  )
}

export function VoiceSplitControl({
  surface,
  danger,
  success,
  disabled,
  mainTitle,
  chevronTitle,
  onMainClick,
  popoverContent,
  children,
}: {
  surface: VoiceSplitControlSurface
  danger?: boolean
  success?: boolean
  disabled?: boolean
  mainTitle: string
  chevronTitle: string
  onMainClick: () => void
  popoverContent: ReactNode
  children: ReactNode
}) {
  const segmentState = { danger, success }

  return (
    <TooltipProvider delay={300}>
      <div className="group/media flex items-center gap-px">
        <VoiceControlTooltip title={mainTitle}>
          <button
            type="button"
            aria-label={mainTitle}
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
          success={success}
          title={chevronTitle}
          popoverContent={popoverContent}
        />
      </div>
    </TooltipProvider>
  )
}
