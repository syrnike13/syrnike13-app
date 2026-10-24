import type { ReactNode } from 'react'
import { ChevronDownIcon } from '#/components/icons'

import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@syrnike13/ui/primitives/popover'
import { Button } from '@syrnike13/ui/primitives/button'
import { ButtonGroup } from '@syrnike13/ui/primitives/button-group'
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@syrnike13/ui/primitives/tooltip'
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

/** Stage surface (voice stage controls); the panel uses PanelSplitControl. */
function stageMainButtonClass({ danger, success }: SegmentState) {
  return cn(
    'flex h-9 min-w-12 shrink-0 items-center justify-center rounded-l-md rounded-r-none px-2 text-muted-foreground transition-colors aria-disabled:cursor-not-allowed aria-disabled:opacity-50',
    danger
      ? splitControlDangerMainClass
      : success
        ? splitControlSuccessMainClass
        : 'group-hover/media:bg-hover group-hover/media:text-foreground',
  )
}

function SplitControlChevron({
  disabled,
  danger,
  success,
  title,
  popoverContent,
  popoverOpen,
  onPopoverOpenChange,
}: {
  disabled: boolean
  danger?: boolean
  success?: boolean
  title: string
  popoverContent: ReactNode
  popoverOpen?: boolean
  onPopoverOpenChange?: (open: boolean) => void
}) {
  const chevronClass = cn(
    'flex h-9 w-7 shrink-0 items-center justify-center rounded-r-md rounded-l-none text-muted-foreground transition-colors aria-disabled:cursor-not-allowed aria-disabled:opacity-50',
    danger
      ? 'bg-destructive/20 text-destructive group-hover/media:bg-destructive/12 group-hover/media:text-destructive'
      : success
        ? 'bg-chart-3/20 text-chart-3 group-hover/media:bg-chart-3/12 group-hover/media:text-chart-3'
        : 'group-hover/media:bg-hover group-hover/media:text-foreground',
  )

  return (
    <Popover open={popoverOpen} onOpenChange={onPopoverOpenChange}>
      <VoiceControlTooltip title={title}>
        <PopoverTrigger render={<button
            type="button"
            aria-label={title}
            aria-disabled={disabled}
            className={chevronClass} />}>
            <ChevronDownIcon className="size-3.5" />
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
        )}
      >
        {popoverContent}
      </PopoverContent>
    </Popover>
  )
}

/**
 * User-panel split control built from primitives: a ButtonGroup of an icon
 * Button and a narrow chevron Button that opens the settings popover.
 */
function PanelSplitControl({
  danger,
  disabled,
  mainTitle,
  chevronTitle,
  onMainClick,
  popoverContent,
  popoverOpen,
  onPopoverOpenChange,
  children,
}: Omit<Parameters<typeof VoiceSplitControl>[0], 'surface' | 'success'>) {
  const variant = danger ? 'destructive' : 'ghost'

  return (
    <ButtonGroup>
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              type="button"
              variant={variant}
              size="icon"
              aria-label={mainTitle}
              aria-disabled={disabled}
              onClick={disabled ? undefined : onMainClick}
            />
          }
        >
          {children}
        </TooltipTrigger>
        <TooltipContent side="top" sideOffset={8}>
          {mainTitle}
        </TooltipContent>
      </Tooltip>
      <Popover open={popoverOpen} onOpenChange={onPopoverOpenChange}>
        <Tooltip>
          <TooltipTrigger
            render={
              <PopoverTrigger
                render={
                  <Button
                    type="button"
                    variant={variant}
                    size="icon-split"
                    aria-label={chevronTitle}
                    aria-disabled={disabled}
                  />
                }
              />
            }
          >
            <ChevronDownIcon />
          </TooltipTrigger>
          <TooltipContent side="top" sideOffset={8}>
            {chevronTitle}
          </TooltipContent>
        </Tooltip>
        <PopoverContent
          align="start"
          side="top"
          sideOffset={8}
          data-voice-stage-popover
          className={cn(
            // eslint-disable-next-line shadcn/require-static-classes -- shared voice popover class
            voiceStagePopoverMicSettingsClass,
            'z-200',
          )}
        >
          {popoverContent}
        </PopoverContent>
      </Popover>
    </ButtonGroup>
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
  popoverOpen,
  onPopoverOpenChange,
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
  /** Управляемое открытие поповера (например, при сбое устройства). */
  popoverOpen?: boolean
  onPopoverOpenChange?: (open: boolean) => void
  children: ReactNode
}) {
  if (surface === 'panel') {
    return (
      <TooltipProvider delay={300}>
        <PanelSplitControl
          danger={danger}
          disabled={disabled}
          mainTitle={mainTitle}
          chevronTitle={chevronTitle}
          onMainClick={onMainClick}
          popoverContent={popoverContent}
          popoverOpen={popoverOpen}
          onPopoverOpenChange={onPopoverOpenChange}
        >
          {children}
        </PanelSplitControl>
      </TooltipProvider>
    )
  }

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
            className={stageMainButtonClass(segmentState)}
          >
            {children}
          </button>
        </VoiceControlTooltip>
        <SplitControlChevron
          disabled={Boolean(disabled)}
          danger={danger}
          success={success}
          title={chevronTitle}
          popoverContent={popoverContent}
          popoverOpen={popoverOpen}
          onPopoverOpenChange={onPopoverOpenChange}
        />
      </div>
    </TooltipProvider>
  )
}
