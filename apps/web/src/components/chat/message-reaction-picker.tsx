import type { ReactElement } from 'react'

import { Button } from '@syrnike13/ui/primitives/button'
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@syrnike13/ui/primitives/popover'
import { QUICK_REACTIONS } from '#/lib/reactions'
import { cn } from '#/lib/utils'

export function MessageReactionPickerContent({
  onPick,
}: {
  onPick: (emoji: string) => void
}) {
  return (
    <div className="grid grid-cols-5 gap-0.5">
      {QUICK_REACTIONS.map((emoji) => (
        <Button
          key={emoji}
          type="button"
          variant="ghost"
          size="icon"
          className="size-8 text-lg"
          onClick={() => onPick(emoji)}
        >
          {emoji}
        </Button>
      ))}
    </div>
  )
}

export function MessageReactionPicker({
  trigger,
  onPick,
  open,
  onOpenChange,
  align = 'end',
}: {
  trigger: ReactElement
  onPick: (emoji: string) => void
  open?: boolean
  onOpenChange?: (open: boolean) => void
  align?: 'start' | 'center' | 'end'
}) {
  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <PopoverTrigger render={trigger} />
      <PopoverContent className={cn('w-auto p-2')} align={align}>
        <MessageReactionPickerContent onPick={onPick} />
      </PopoverContent>
    </Popover>
  )
}
