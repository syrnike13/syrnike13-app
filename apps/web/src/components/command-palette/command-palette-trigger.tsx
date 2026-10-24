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
      variant="secondary"
      size="sm"
      onClick={() => setOpen(true)}
      className={cn('w-full justify-start text-muted-foreground', className)}
    >
      <SearchIcon data-icon="inline-start" />
      <span className="min-w-0 flex-1 truncate text-left">{label}</span>
      <Kbd className="hidden sm:inline-flex">{shortcut}</Kbd>
    </Button>
  )
}
