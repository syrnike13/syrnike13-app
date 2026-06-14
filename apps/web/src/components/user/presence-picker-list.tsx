import { CheckIcon } from '#/components/icons'
import type { ManualPresence } from '@syrnike13/api-types'

import { profileMenuRowClass } from '#/components/user/profile-menu-row'
import { PRESENCE_DISPLAY, PRESENCE_OPTIONS } from '#/lib/presence'
import { useSetPresence } from '#/features/users/use-set-presence'
import { cn } from '#/lib/utils'

type PresencePickerListProps = {
  onSelected?: () => void
  className?: string
}

export function PresencePickerList({
  onSelected,
  className,
}: PresencePickerListProps) {
  const { presence, setPresence, isPending } = useSetPresence()
  const current = PRESENCE_DISPLAY[presence ?? 'Online'] ?? PRESENCE_OPTIONS[0]

  async function pick(next: ManualPresence) {
    if (next === presence || isPending) return
    await setPresence(next)
    onSelected?.()
  }

  return (
    <div className={cn('flex flex-col gap-0.5 p-2', className)} role="listbox">
      {PRESENCE_OPTIONS.map((option) => {
        const selected = option.value === current.value
        return (
          <button
            key={option.value}
            type="button"
            role="option"
            aria-selected={selected}
            disabled={isPending}
            className={cn(
              profileMenuRowClass,
              'h-11 justify-between rounded-lg px-3',
              selected && 'bg-accent/70 text-foreground',
            )}
            onClick={() => void pick(option.value)}
          >
            <span className="flex min-w-0 items-center gap-3">
              <span
                className={cn('size-3 shrink-0 rounded-full', option.dotClass)}
                aria-hidden
              />
              <span className="truncate text-base">{option.label}</span>
            </span>
            {selected ? (
              <CheckIcon className="size-4 shrink-0 text-primary" />
            ) : (
              <span className="size-4 shrink-0" aria-hidden />
            )}
          </button>
        )
      })}
    </div>
  )
}
