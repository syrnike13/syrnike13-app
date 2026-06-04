import { useState } from 'react'
import { BellOffIcon, CheckIcon, ChevronRightIcon } from 'lucide-react'
import type { Presence } from '@syrnike13/api-types'

import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '#/components/ui/popover'
import { profileMenuRowClass } from '#/components/user/profile-menu-row'
import { PRESENCE_OPTIONS } from '#/lib/presence'
import { useSetPresence } from '#/features/users/use-set-presence'
import { cn } from '#/lib/utils'

type PresenceStatusSelectProps = {
  className?: string
  onSelected?: () => void
}

export function PresenceStatusSelect({
  className,
  onSelected,
}: PresenceStatusSelectProps) {
  const [open, setOpen] = useState(false)
  const { presence, setPresence, isPending } = useSetPresence()
  const current =
    PRESENCE_OPTIONS.find((option) => option.value === presence) ??
    PRESENCE_OPTIONS[0]

  const showMutedBell = presence === 'Busy' || presence === 'Focus'

  async function pick(next: Presence) {
    if (next === presence || isPending) return
    await setPresence(next)
    setOpen(false)
    onSelected?.()
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          disabled={isPending}
          data-state={open ? 'open' : 'closed'}
          className={cn(profileMenuRowClass, className)}
          aria-haspopup="listbox"
          aria-expanded={open}
        >
          <span
            className={cn(
              'size-3 shrink-0 rounded-full',
              current.dotClass,
            )}
            aria-hidden
          />
          <span className="min-w-0 flex-1 truncate">{current.label}</span>
          {showMutedBell ? (
            <BellOffIcon
              className="size-4 shrink-0 opacity-60 transition-opacity group-hover:opacity-100 group-data-[state=open]:opacity-100"
              aria-hidden
            />
          ) : null}
          <ChevronRightIcon
            className="size-4 shrink-0 opacity-50 transition-opacity group-hover:opacity-90 group-data-[state=open]:opacity-90"
            aria-hidden
          />
        </button>
      </PopoverTrigger>
      <PopoverContent
        side="right"
        align="start"
        sideOffset={6}
        collisionPadding={12}
        className="z-[250] w-52 p-1"
        onOpenAutoFocus={(event) => event.preventDefault()}
      >
        {PRESENCE_OPTIONS.map((option) => {
          const selected = option.value === presence
          return (
            <button
              key={option.value}
              type="button"
              disabled={isPending}
              className={cn(
                profileMenuRowClass,
                'justify-between',
                selected && 'bg-accent/70 text-foreground',
              )}
              onClick={() => void pick(option.value)}
            >
              <span className="flex min-w-0 items-center gap-2">
                <span
                  className={cn(
                    'size-3 shrink-0 rounded-full',
                    option.dotClass,
                  )}
                  aria-hidden
                />
                <span className="truncate">{option.label}</span>
              </span>
              {selected ? (
                <CheckIcon className="size-4 shrink-0 text-primary" />
              ) : (
                <span className="size-4 shrink-0" aria-hidden />
              )}
            </button>
          )
        })}
      </PopoverContent>
    </Popover>
  )
}
