import type { ReactNode } from 'react'

import { Button } from '#/components/ui/button'
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '#/components/ui/popover'
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
  trigger: ReactNode
  onPick: (emoji: string) => void
  open?: boolean
  onOpenChange?: (open: boolean) => void
  align?: 'start' | 'center' | 'end'
}) {
  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <PopoverTrigger asChild>{trigger}</PopoverTrigger>
      <PopoverContent className={cn('w-auto p-2')} align={align}>
        <MessageReactionPickerContent onPick={onPick} />
      </PopoverContent>
    </Popover>
  )
}
