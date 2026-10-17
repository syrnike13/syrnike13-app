import type { ReactElement, ReactNode } from 'react'

import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@syrnike13/ui/primitives/tooltip'
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
      <TooltipTrigger
        render={
          <span
            className={cn(
              'inline-flex',
              // eslint-disable-next-line shadcn/require-static-classes -- caller-owned tooltip wrapper styling
              wrapperClassName,
            )}
          />
        }
      >
        {children}
      </TooltipTrigger>
      <TooltipContent
        side="top"
        sideOffset={8}
        className={
          // eslint-disable-next-line shadcn/require-static-classes -- caller-owned tooltip content styling
          contentClassName
        }
      >
        {content ?? title}
      </TooltipContent>
    </Tooltip>
  )
}
