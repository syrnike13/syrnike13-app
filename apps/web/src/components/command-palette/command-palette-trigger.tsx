import { SearchIcon } from 'lucide-react'
import { useMemo } from 'react'

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
  placeholder = 'Найти или начать беседу',
}: CommandPaletteTriggerProps) {
  const { setOpen } = useCommandPalette()
  const shortcut = useMemo(() => shortcutLabel(), [])

  return (
    <button
      type="button"
      onClick={() => setOpen(true)}
      className={cn(
        'flex h-8 w-full items-center gap-2 rounded-md border border-sidebar-border px-2.5 text-left text-sm',
        'bg-sidebar-accent text-sidebar-accent-foreground shadow-sm',
        'transition-colors hover:bg-sidebar-primary hover:text-sidebar-primary-foreground',
        className,
      )}
    >
      <SearchIcon className="size-4 shrink-0 opacity-80" />
      <span className="min-w-0 flex-1 truncate">{placeholder}</span>
      <kbd className="hidden shrink-0 rounded border border-sidebar-border bg-sidebar px-1 py-0.5 text-[10px] font-medium text-sidebar-foreground sm:inline">
        {shortcut}
      </kbd>
    </button>
  )
}
