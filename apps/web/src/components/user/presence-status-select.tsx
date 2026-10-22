import { useState } from 'react'
import { useTranslations } from '@syrnike13/ui/i18n'
import { BellOffIcon, ChevronRightIcon } from '#/components/icons'
import type { ManualPresence } from '@syrnike13/api-types'

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from '@syrnike13/ui/primitives/dropdown-menu'
import { profileMenuRowClass } from '#/components/user/profile-menu-row'
import { PRESENCE_DISPLAY, PRESENCE_OPTIONS } from '#/lib/presence'
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
  const t = useTranslations('chat')
  const [open, setOpen] = useState(false)
  const { presence, setPresence, isPending } = useSetPresence()
  const current = PRESENCE_DISPLAY[presence ?? 'Online'] ?? PRESENCE_OPTIONS[0]

  const showMutedBell = presence === 'Busy' || presence === 'Focus'

  async function pick(next: ManualPresence) {
    if (next === presence || isPending) return
    await setPresence(next)
    setOpen(false)
    onSelected?.()
  }

  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <DropdownMenuTrigger
        disabled={isPending}
        render={
          <button
            type="button"
            className={cn(
              // eslint-disable-next-line shadcn/require-static-classes -- shared profile menu row class
              profileMenuRowClass,
              'data-[popup-open]:bg-accent/60 data-[popup-open]:text-foreground',
              className,
            )}
          />
        }
      >
        <span
          className={cn('size-3 shrink-0 rounded-full', current.dotClass)}
          aria-hidden
        />
        <span className="min-w-0 flex-1 truncate">{t(current.labelKey)}</span>
        {showMutedBell ? (
          <BellOffIcon
            className="size-4 shrink-0 opacity-60 transition-opacity group-hover:opacity-100 group-data-[popup-open]:opacity-100"
            aria-hidden
          />
        ) : null}
        <ChevronRightIcon
          className="size-4 shrink-0 opacity-50 transition-opacity group-hover:opacity-90 group-data-[popup-open]:opacity-90"
          aria-hidden
        />
      </DropdownMenuTrigger>
      <DropdownMenuContent side="right" align="start" sideOffset={6} className="w-52">
        <DropdownMenuRadioGroup
          value={current.value}
          onValueChange={(next) => void pick(next as ManualPresence)}
        >
          {PRESENCE_OPTIONS.map((option) => (
            <DropdownMenuRadioItem
              key={option.value}
              value={option.value}
              disabled={isPending}
              className="gap-2"
            >
              <span className="flex min-w-0 items-center gap-2">
                <span
                  className={cn(
                    'size-3 shrink-0 rounded-full',
                    option.dotClass,
                  )}
                  aria-hidden
                />
                <span className="truncate">{t(option.labelKey)}</span>
              </span>
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
