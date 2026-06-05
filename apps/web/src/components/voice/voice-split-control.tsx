import type { ReactNode } from 'react'
import { ChevronDownIcon } from 'lucide-react'

import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '#/components/ui/popover'
import { voiceStagePopoverMicSettingsClass } from '#/components/voice/voice-stage-popover-styles'
import { cn } from '#/lib/utils'

export type VoiceSplitControlSurface = 'stage' | 'panel'

type SegmentState = {
  danger?: boolean
}

const splitControlDangerMainClass =
  'bg-[#ed4245]/20 text-[#ff5c5c] group-hover/media:bg-[#ed4245]/30 group-hover/media:text-[#ff6b6b]'

const splitControlDangerChevronClass =
  'bg-[#ed4245]/20 text-[#ff5c5c] group-hover/media:bg-[#ed4245]/12 group-hover/media:text-[#ff6b6b]'

export function splitControlMainButtonClass(
  surface: VoiceSplitControlSurface,
  { danger }: SegmentState,
) {
  if (surface === 'stage') {
    return cn(
      'flex h-9 min-w-12 shrink-0 items-center justify-center rounded-l-md rounded-r-none px-2 text-white/80 transition-colors disabled:pointer-events-none disabled:opacity-50',
      danger ? splitControlDangerMainClass : 'group-hover/media:bg-white/10 group-hover/media:text-white',
    )
  }

  return cn(
    'flex size-9 shrink-0 items-center justify-center rounded-l-md rounded-r-none transition-colors disabled:pointer-events-none disabled:opacity-50',
    danger
      ? splitControlDangerMainClass
      : 'bg-card text-muted-foreground group-hover/media:bg-accent group-hover/media:text-foreground',
  )
}

export function splitControlChevronButtonClass(
  surface: VoiceSplitControlSurface,
  { danger }: SegmentState,
) {
  if (surface === 'stage') {
    return cn(
      'flex h-9 w-7 shrink-0 items-center justify-center rounded-r-md rounded-l-none text-white/80 transition-colors disabled:pointer-events-none disabled:opacity-50',
      danger
        ? splitControlDangerChevronClass
        : 'group-hover/media:bg-white/[0.06] group-hover/media:text-white',
    )
  }

  return cn(
    'flex h-9 w-5 shrink-0 items-center justify-center rounded-r-md rounded-l-none transition-colors disabled:pointer-events-none disabled:opacity-50',
    danger
      ? splitControlDangerChevronClass
      : 'bg-card text-muted-foreground group-hover/media:bg-accent group-hover/media:text-foreground',
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
      <PopoverTrigger asChild>
        <button
          type="button"
          title={title}
          disabled={disabled}
          className={splitControlChevronButtonClass(surface, segmentState)}
        >
          <ChevronDownIcon
            className={surface === 'panel' ? 'size-3' : 'size-3.5'}
          />
        </button>
      </PopoverTrigger>
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
    <div className="group/media flex items-center gap-px">
      <button
        type="button"
        title={mainTitle}
        disabled={disabled}
        onClick={onMainClick}
        className={splitControlMainButtonClass(surface, segmentState)}
      >
        {children}
      </button>
      <SplitControlChevron
        surface={surface}
        disabled={Boolean(disabled)}
        danger={danger}
        title={chevronTitle}
        popoverContent={popoverContent}
      />
    </div>
  )
}
