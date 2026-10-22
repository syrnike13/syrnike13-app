import { SearchIcon } from '#/components/icons'
import { useMemo } from 'react'
import { useTranslations } from '@syrnike13/ui/i18n'

import { Button } from '@syrnike13/ui/primitives/button'
import { Kbd } from '@syrnike13/ui/primitives/kbd'
import { useCommandPalette } from '#/features/command-palette/command-palette-context'
import { cn } from '#/lib/utils'

function shortcutLabel() {
  if (typeof navigator === 'undefined') return 'Ctrl+K'
  return /Mac|iPhone|iPad/.test(navigator.platform) ? '⌘K' : 'Ctrl+K'
}

type CommandPaletteTriggerProps = {
  className?: string
  placeholder?: string
}

export function CommandPaletteTrigger({
  className,
  placeholder,
}: CommandPaletteTriggerProps) {
  const t = useTranslations('commandPalette')
  const label = placeholder ?? t('triggerPlaceholder')
  const { setOpen } = useCommandPalette()
  const shortcut = useMemo(() => shortcutLabel(), [])

  return (
    <Button
      type="button"
      variant="outline"
      onClick={() => setOpen(true)}
      className={cn('h-8 w-full justify-start gap-2 px-2.5 font-normal', className)}
    >
      <SearchIcon className="size-4 shrink-0 text-muted-foreground" />
      <span className="min-w-0 flex-1 truncate text-left">{label}</span>
      <Kbd className="hidden sm:inline-flex">{shortcut}</Kbd>
    </Button>
  )
}
