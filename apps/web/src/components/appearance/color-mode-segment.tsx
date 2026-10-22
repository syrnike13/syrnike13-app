import type { AppearanceColorMode } from '@syrnike13/platform'
import { useTranslations } from '@syrnike13/ui/i18n'

import {
  ToggleGroup,
  ToggleGroupItem,
} from '@syrnike13/ui/primitives/toggle-group'

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
    <ToggleGroup
      aria-label={t('displayMode')}
      value={[value]}
      onValueChange={(next) => {
        const nextMode = next[0]
        if (nextMode) onChange(nextMode as AppearanceColorMode)
      }}
      multiple={false}
      disabled={disabled}
      variant="outline"
      size="sm"
      spacing={0}
    >
      {MODES.map((mode) => (
        <ToggleGroupItem key={mode.id} value={mode.id}>
          {t(mode.labelKey)}
        </ToggleGroupItem>
      ))}
    </ToggleGroup>
  )
}
