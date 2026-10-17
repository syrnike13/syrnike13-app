import type { AppearanceColorMode } from '@syrnike13/platform'
import { useTranslations } from '@syrnike13/ui/i18n'

import { cn } from '#/lib/utils'

const MODES = [
  { id: 'light', labelKey: 'modes.light' },
  { id: 'dark', labelKey: 'modes.dark' },
  { id: 'system', labelKey: 'modes.system' },
] as const satisfies ReadonlyArray<{
  id: AppearanceColorMode
  labelKey: string
}>

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
  const t = useTranslations('settings.appearance')

  return (
    <div
      className={cn(
        'inline-flex rounded-lg border border-border bg-muted/40 p-1',
        disabled && 'pointer-events-none opacity-50',
      )}
      role="group"
      aria-label={t('displayMode')}
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
          {t(mode.labelKey)}
        </button>
      ))}
    </div>
  )
}
