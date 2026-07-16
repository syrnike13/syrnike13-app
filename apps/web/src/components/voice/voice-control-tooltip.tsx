import type { ReactElement, ReactNode } from 'react'

import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '#/components/ui/tooltip'
import { cn } from '#/lib/utils'

export function VoiceControlTooltip({
  title,
  content,
  wrapperClassName,
  contentClassName,
  children,
}: {
  title: string
  content?: ReactNode
  wrapperClassName?: string
  contentClassName?: string
  children: ReactElement
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className={cn('inline-flex', wrapperClassName)}>{children}</span>
      </TooltipTrigger>
      <TooltipContent
        side="top"
        sideOffset={8}
        className={contentClassName}
      >
        {content ?? title}
      </TooltipContent>
    </Tooltip>
  )
}
