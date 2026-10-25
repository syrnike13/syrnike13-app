import type { ManualPresence } from '@syrnike13/api-types'
import { useTranslations } from '@syrnike13/ui/i18n'

import { RadioGroup, RadioGroupItem } from '@syrnike13/ui/primitives/radio-group'
import { SidebarMenuButton } from '@syrnike13/ui/primitives/sidebar'
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
  const t = useTranslations('chat')
  const { presence, setPresence, isPending } = useSetPresence()
  const current = PRESENCE_DISPLAY[presence ?? 'Online'] ?? PRESENCE_OPTIONS[0]

  async function pick(next: ManualPresence) {
    if (next === presence || isPending) return
    await setPresence(next)
    onSelected?.()
  }

  return (
    <RadioGroup
      value={current.value}
      disabled={isPending}
      className={cn('flex flex-col gap-0.5 p-2', className)}
      onValueChange={(next) => void pick(next as ManualPresence)}
    >
      {PRESENCE_OPTIONS.map((option) => {
        const selected = option.value === current.value
        return (
          <SidebarMenuButton
            key={option.value}
            size="lg"
            isActive={selected}
            render={<label />}
            className="cursor-pointer justify-between"
          >
            <span className="flex min-w-0 items-center gap-3">
              <span
                className={cn('size-3 shrink-0 rounded-full', option.dotClass)}
                aria-hidden
              />
              <span className="truncate">{t(option.labelKey)}</span>
            </span>
            <RadioGroupItem value={option.value} disabled={isPending} />
          </SidebarMenuButton>
        )
      })}
    </RadioGroup>
  )
}
