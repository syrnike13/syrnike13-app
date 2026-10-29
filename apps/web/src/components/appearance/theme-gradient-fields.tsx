import {
  APPEARANCE_GRADIENT_MAX_COLORS,
  APPEARANCE_GRADIENT_MIN_COLORS,
  type AppearanceGradientSettings,
} from '@syrnike13/platform'
import { useTranslations } from '@syrnike13/ui/i18n'
import { Button } from '@syrnike13/ui/primitives/button'
import { Field, FieldTitle } from '@syrnike13/ui/primitives/field'
import { Input } from '@syrnike13/ui/primitives/input'
import { Switch } from '@syrnike13/ui/primitives/switch'
import { PlusIcon, XIcon } from '#/components/icons'
import { PresetSlider } from '#/components/ui/preset-slider'

const ANGLE_STOPS = [{ value: 0 }, { value: 359 }]
const MIX_STOPS = [{ value: 0 }, { value: 100 }]
export const DEFAULT_GRADIENT = { angle: 135, mix: 60 }

/**
 * Window gradient of one variant: on/off, color stops, angle and coverage.
 * Used by the DEV workbench; the theme editor drives stops through its picker.
 */
export function ThemeGradientFields({
  value,
  defaultColors,
  onChange,
}: {
  value: AppearanceGradientSettings | undefined
  defaultColors: [string, string]
  onChange: (gradient: AppearanceGradientSettings | undefined) => void
}) {
  const t = useTranslations('settings.appearance.themeEditor.gradient')
  const colors = value?.colors ?? []
  const canRemove = colors.length > APPEARANCE_GRADIENT_MIN_COLORS
  const canAdd = colors.length < APPEARANCE_GRADIENT_MAX_COLORS
  const setColors = (next: string[]) => {
    if (!value) return
    onChange({ ...value, colors: next })
  }

  const removeStop = () => setColors(colors.slice(0, -1))
  const addStop = () => setColors([...colors, colors[colors.length - 1]!])

  return (
    <>
      <Field orientation="horizontal">
        <FieldTitle>{t('enabled')}</FieldTitle>
        <Switch
          aria-label={t('enabled')}
          checked={Boolean(value)}
          onCheckedChange={(checked) =>
            onChange(
              checked
                ? { ...DEFAULT_GRADIENT, colors: [...defaultColors] }
                : undefined,
            )
          }
        />
      </Field>
      {value ? (
        <>
          <Field>
            <div className="flex min-h-6 items-center justify-between gap-2">
              <FieldTitle>{t('colors')}</FieldTitle>
              <div className="flex items-center gap-1">
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-xs"
                  disabled={!canRemove}
                  aria-label={t('removeStop', { index: colors.length })}
                  title={t('removeStop', { index: colors.length })}
                  onClick={removeStop}
                >
                  <XIcon />
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-xs"
                  disabled={!canAdd}
                  aria-label={t('addStop')}
                  title={t('addStop')}
                  onClick={addStop}
                >
                  <PlusIcon />
                </Button>
              </div>
            </div>
            <div className="flex flex-wrap gap-2">
              {colors.map((color, index) => (
                <Input
                  key={index}
                  type="color"
                  aria-label={t('colorStop', { index: index + 1 })}
                  value={color}
                  className="w-14"
                  onChange={(event) =>
                    setColors(
                      colors.map((stop, i) =>
                        i === index
                          ? event.target.value.toUpperCase()
                          : stop,
                      ),
                    )
                  }
                />
              ))}
            </div>
          </Field>
          <Field>
            <div className="flex items-center justify-between gap-2">
              <FieldTitle>{t('angle')}</FieldTitle>
              <span className="text-sm tabular-nums text-muted-foreground">
                {value.angle}°
              </span>
            </div>
            <PresetSlider
              aria-label={t('angle')}
              mode="continuous"
              stops={ANGLE_STOPS}
              step={1}
              value={value.angle}
              showLabels={false}
              showMarks={false}
              formatValue={(angle) => `${angle}°`}
              onValueChange={(angle) => onChange({ ...value, angle })}
            />
          </Field>
          <Field>
            <div className="flex items-center justify-between gap-2">
              <FieldTitle>{t('mix')}</FieldTitle>
              <span className="text-sm tabular-nums text-muted-foreground">
                {value.mix}%
              </span>
            </div>
            <PresetSlider
              aria-label={t('mix')}
              mode="continuous"
              stops={MIX_STOPS}
              step={1}
              value={value.mix}
              showLabels={false}
              showMarks={false}
              formatValue={(mix) => `${mix}%`}
              onValueChange={(mix) => onChange({ ...value, mix })}
            />
          </Field>
        </>
      ) : null}
    </>
  )
}
