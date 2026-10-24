import type { ReactNode } from 'react'

import { ChevronDownIcon } from '#/components/icons'
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@syrnike13/ui/primitives/popover'
import {
  SplitButton,
  SplitButtonChevron,
  SplitButtonMain,
} from '@syrnike13/ui/primitives/split-button'
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@syrnike13/ui/primitives/tooltip'
import { voiceStagePopoverMicSettingsClass } from '#/components/voice/voice-stage-popover-styles'
import { cn } from '#/lib/utils'

export type VoiceSplitControlSurface = 'stage' | 'panel'

/** Standalone (non-split) danger button on the voice stage. */
export const splitControlDangerStandaloneClass =
  'bg-destructive/20 text-destructive hover:bg-destructive/30 hover:text-destructive'

/**
 * Mic, sound and camera control: a SplitButton whose chevron opens the device
 * settings popover. The user panel uses the compact size, the voice stage `lg`.
 */
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
  return (
    <TooltipProvider delay={300}>
      <SplitButton
        size={surface === 'stage' ? 'lg' : 'default'}
        variant={
          danger
            ? 'destructive'
            : success
              ? 'success'
              : surface === 'stage'
                ? 'media'
                : 'default'
        }
      >
        <Tooltip>
          <TooltipTrigger
            render={
              <SplitButtonMain
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
                    <SplitButtonChevron
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
              surface === 'panel' && 'z-200',
            )}
          >
            {popoverContent}
          </PopoverContent>
        </Popover>
      </SplitButton>
    </TooltipProvider>
  )
}
