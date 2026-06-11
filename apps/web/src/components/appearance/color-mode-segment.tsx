import type { AppearanceColorMode } from '@syrnike13/platform'

import { cn } from '#/lib/utils'

const MODES: { id: AppearanceColorMode; label: string }[] = [
  { id: 'light', label: 'Светлая' },
  { id: 'dark', label: 'Тёмная' },
  { id: 'system', label: 'Системная' },
]

type ColorModeSegmentProps = {
  value: AppearanceColorMode
  disabled?: boolean
  onChange: (mode: AppearanceColorMode) => void
}

export function ColorModeSegment({
  value,
  disabled,
  onChange,
}: ColorModeSegmentProps) {
  return (
    <div
      className={cn(
        'inline-flex rounded-lg border border-border bg-muted/40 p-1',
        disabled && 'pointer-events-none opacity-50',
      )}
      role="group"
      aria-label="Режим отображения"
    >
      {MODES.map((mode) => (
        <button
          key={mode.id}
          type="button"
          disabled={disabled}
          onClick={() => onChange(mode.id)}
          className={cn(
            'rounded-md px-3 py-1.5 text-sm font-medium transition-colors',
            value === mode.id
              ? 'bg-background text-foreground shadow-sm'
              : 'text-muted-foreground hover:text-foreground',
          )}
        >
          {mode.label}
        </button>
      ))}
    </div>
  )
}
