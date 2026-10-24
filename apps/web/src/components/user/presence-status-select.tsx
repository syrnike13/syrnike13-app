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
import {
  Item,
  ItemActions,
  ItemContent,
  ItemMedia,
  ItemTitle,
} from '@syrnike13/ui/primitives/item'
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
        // Discord: nested profile menus open on hover, like submenus.
        openOnHover
        delay={50}
        disabled={isPending}
        render={
          <Item
            size="sm"
            className={className}
            render={<button type="button" />}
          />
        }
      >
        <ItemMedia variant="icon">
          <span className={cn('size-3 rounded-full', current.dotClass)} aria-hidden />
        </ItemMedia>
        <ItemContent>
          <ItemTitle>{t(current.labelKey)}</ItemTitle>
        </ItemContent>
        <ItemActions className="text-muted-foreground">
          {showMutedBell ? <BellOffIcon aria-hidden /> : null}
          <ChevronRightIcon aria-hidden />
        </ItemActions>
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
