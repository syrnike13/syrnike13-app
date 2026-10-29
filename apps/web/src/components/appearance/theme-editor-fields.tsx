import {
  APPEARANCE_CUSTOM_THEME_NAME_MAX,
  APPEARANCE_GRADIENT_MAX_COLORS,
  APPEARANCE_GRADIENT_MIN_COLORS,
  APPEARANCE_THEME_CONTRAST_MAX,
  cloneAppearanceThemeAnchors,
  type AppearanceCustomTheme,
  type AppearanceThemeAnchors,
  type AppearanceThemeVariant,
} from '@syrnike13/platform'
import { useTranslations } from '@syrnike13/ui/i18n'
import { Button } from '@syrnike13/ui/primitives/button'
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@syrnike13/ui/primitives/collapsible'
import {
  Field,
  FieldGroup,
  FieldLabel,
  FieldLegend,
  FieldSet,
  FieldTitle,
} from '@syrnike13/ui/primitives/field'
import { Input } from '@syrnike13/ui/primitives/input'
import { Tabs, TabsList, TabsTrigger } from '@syrnike13/ui/primitives/tabs'
import {
  ToggleGroup,
  ToggleGroupItem,
} from '@syrnike13/ui/primitives/toggle-group'
import { listThemes, type ThemeDefinition } from '@syrnike13/ui/tokens'
import { useId, useState, type ReactNode } from 'react'

import {
  ChevronDownIcon,
  MoonIcon,
  PlusIcon,
  SunIcon,
} from '#/components/icons'
import { ThemeColorPicker } from '#/components/appearance/theme-color-picker'
import { DEFAULT_GRADIENT } from '#/components/appearance/theme-gradient-fields'
import { ThemePreviewMini } from '#/components/appearance/theme-preview-mini'
import { PresetSlider } from '#/components/ui/preset-slider'
import {
  anchorsForNewTheme,
  deriveSurfaceAnchors,
  randomThemeAnchors,
} from '#/features/appearance/appearance-themes'
import type { CSSVars } from '#/lib/css-vars'

const CONTRAST_STOPS = [{ value: 0 }, { value: APPEARANCE_THEME_CONTRAST_MAX }]
const ANGLE_STOPS = [{ value: 0 }, { value: 359 }]
const MIX_STOPS = [{ value: 0 }, { value: 100 }]
const ANCHOR_KEYS = ['accent', 'background', 'foreground'] as const
type AnchorKey = (typeof ANCHOR_KEYS)[number]
const isAnchorKey = (value: string): value is AnchorKey =>
  (ANCHOR_KEYS as readonly string[]).includes(value)
type ColorSelection =
  | { kind: 'anchor'; key: AnchorKey }
  | { kind: 'gradient'; index: number }

export type ThemeEditorDraft = {
  name: string
  setName: (name: string) => void
  variant: AppearanceThemeVariant
  setVariant: (variant: AppearanceThemeVariant) => void
  anchors: AppearanceCustomTheme['anchors']
  setAnchor: <Key extends keyof AppearanceThemeAnchors>(
    key: Key,
    value: AppearanceThemeAnchors[Key],
  ) => void
  previewTheme: ThemeDefinition
  canSubmit: boolean
  isDirty: boolean
  reset: () => boolean
  randomize: () => void
}

export function useThemeDraft(
  initial: AppearanceCustomTheme | null,
  initialAnchors: AppearanceCustomTheme['anchors'] | null,
  initialVariant: AppearanceThemeVariant = 'light',
): ThemeEditorDraft {
  const [baseline] = useState(() => ({
    name: initial?.name ?? '',
    anchors: initial?.anchors ?? initialAnchors ?? anchorsForNewTheme(),
  }))
  const [name, setName] = useState(baseline.name)
  const [variant, setVariant] = useState(initialVariant)
  const [anchors, setAnchors] = useState<AppearanceCustomTheme['anchors']>(
    () => ({
      light: cloneAppearanceThemeAnchors(baseline.anchors.light),
      dark: cloneAppearanceThemeAnchors(baseline.anchors.dark),
    }),
  )

  const setAnchor = <Key extends keyof AppearanceThemeAnchors>(
    key: Key,
    value: AppearanceThemeAnchors[Key],
  ) => {
    setAnchors((current) => ({
      ...current,
      [variant]: { ...current[variant], [key]: value },
    }))
  }

  return {
    name,
    setName,
    variant,
    setVariant,
    anchors,
    setAnchor,
    previewTheme: { id: 'draft', anchors },
    canSubmit: name.trim().length > 0,
    isDirty:
      name !== baseline.name ||
      JSON.stringify(anchors) !== JSON.stringify(baseline.anchors),
    reset: () => {
      setName(baseline.name)
      setAnchors({
        light: cloneAppearanceThemeAnchors(baseline.anchors.light),
        dark: cloneAppearanceThemeAnchors(baseline.anchors.dark),
      })
      return true
    },
    randomize: () => {
      setAnchors((current) => {
        const next = randomThemeAnchors()
        const families = listThemes().filter(
          (theme) =>
            theme.anchors.light.gradient && theme.anchors.dark.gradient,
        )
        const family = families[Math.floor(Math.random() * families.length)]!
        for (const mode of ['light', 'dark'] as const) {
          if (current[mode].gradient) {
            next[mode] = cloneAppearanceThemeAnchors({
              ...family.anchors[mode],
              contrast: family.anchors[mode].contrast ?? next[mode].contrast,
            })
          }
        }
        return next
      })
    },
  }
}

/** Section title that keeps the editor scannable at a glance. */
function EditorSection({
  label,
  children,
}: {
  label: string
  children: ReactNode
}) {
  return (
    <FieldSet className="gap-3">
      <FieldLegend variant="label" className="mb-3">
        {label}
      </FieldLegend>
      {children}
    </FieldSet>
  )
}

/** Labelled continuous slider with its current value on the right. */
function SliderField({
  label,
  value,
  unit,
  stops,
  onChange,
}: {
  label: string
  value: number
  unit: string
  stops: { value: number }[]
  onChange: (value: number) => void
}) {
  return (
    <Field>
      <div className="flex items-center justify-between gap-2">
        <FieldTitle>{label}</FieldTitle>
        <span className="text-sm tabular-nums text-muted-foreground">
          {value}
          {unit}
        </span>
      </div>
      <PresetSlider
        aria-label={label}
        mode="continuous"
        step={1}
        stops={stops}
        value={value}
        showLabels={false}
        showMarks={false}
        formatValue={(next) => `${next}${unit}`}
        onValueChange={onChange}
      />
    </Field>
  )
}

/**
 * Editor shared by the live-preview sidebar and the mobile dialog: appearance,
 * colors (anchors plus optional gradient stops) and fine settings.
 */
export function ThemeEditorFields({
  draft,
  showPreview = false,
}: {
  draft: ThemeEditorDraft
  showPreview?: boolean
}) {
  const t = useTranslations('settings.appearance.themeEditor')
  const nameId = useId()
  const [selection, setSelection] = useState<ColorSelection>({
    kind: 'anchor',
    key: 'accent',
  })
  // Simple mode: one accent color, background and text follow it. Themes whose
  // surfaces were tuned by hand open with the extra colors shown.
  const [advanced] = useState(() =>
    (['light', 'dark'] as const).some((variant) => {
      const { accent, background, foreground } = draft.anchors[variant]
      const derived = deriveSurfaceAnchors(variant, accent)
      return (
        derived.background !== background.toUpperCase() ||
        derived.foreground !== foreground.toUpperCase()
      )
    }),
  )
  const activeAnchors = draft.anchors[draft.variant]
  const gradient = activeAnchors.gradient
  const stops = gradient?.colors ?? []
  // A reset or variant switch can remove the selected gradient stop.
  const selected: ColorSelection =
    selection.kind === 'gradient' && !stops[selection.index]
      ? { kind: 'anchor', key: 'accent' }
      : selection
  const color =
    selected.kind === 'anchor'
      ? activeAnchors[selected.key]
      : stops[selected.index]!

  const changeColor = (value: string) => {
    if (selected.kind === 'anchor') {
      draft.setAnchor(selected.key, value)
      if (!advanced && selected.key === 'accent') {
        const surfaces = deriveSurfaceAnchors(draft.variant, value)
        draft.setAnchor('background', surfaces.background)
        draft.setAnchor('foreground', surfaces.foreground)
      }
    } else if (gradient)
      draft.setAnchor('gradient', {
        ...gradient,
        colors: stops.map((stop, index) =>
          index === selected.index ? value : stop,
        ),
      })
  }

  // Discord-style strip above the picker: one marker per gradient stop, or the
  // accent alone while the theme is a solid color.
  const stripColors = gradient ? stops : [activeAnchors.accent]
  const stripSelected = gradient
    ? selected.kind === 'gradient'
      ? selected.index
      : null
    : selected.kind === 'anchor' && selected.key === 'accent'
      ? 0
      : null
  const stripBackground = `linear-gradient(to right, ${
    stripColors.length > 1 ? stripColors.join(', ') : `${stripColors[0]}, ${stripColors[0]}`
  })`

  const canAdd = stops.length < APPEARANCE_GRADIENT_MAX_COLORS
  const addColor = () => {
    if (!canAdd) return
    if (!gradient) {
      draft.setAnchor('gradient', {
        ...DEFAULT_GRADIENT,
        colors: [activeAnchors.background, activeAnchors.accent],
      })
      setSelection({ kind: 'gradient', index: 1 })
      return
    }
    draft.setAnchor('gradient', {
      ...gradient,
      colors: [...stops, stops[stops.length - 1]!],
    })
    setSelection({ kind: 'gradient', index: stops.length })
  }

  // Dropping below the minimum stop count turns the gradient off.
  const removeColor = () => {
    if (!gradient || selected.kind !== 'gradient') return
    if (stops.length <= APPEARANCE_GRADIENT_MIN_COLORS) {
      draft.setAnchor('gradient', undefined)
      setSelection({ kind: 'anchor', key: 'accent' })
      return
    }
    draft.setAnchor('gradient', {
      ...gradient,
      colors: stops.filter((_, index) => index !== selected.index),
    })
    setSelection({
      kind: 'gradient',
      index: Math.min(selected.index, stops.length - 2),
    })
  }

  return (
    <FieldGroup className="gap-6">
      <Field>
        <FieldLabel htmlFor={nameId}>{t('name')}</FieldLabel>
        <Input
          id={nameId}
          value={draft.name}
          maxLength={APPEARANCE_CUSTOM_THEME_NAME_MAX}
          placeholder={t('namePlaceholder')}
          onChange={(event) => draft.setName(event.target.value)}
        />
      </Field>
      <EditorSection label={t('variant')}>
        <Tabs
          value={draft.variant}
          onValueChange={(value) =>
            (value === 'light' || value === 'dark') && draft.setVariant(value)
          }
        >
          <TabsList className="w-full" aria-label={t('variant')}>
            <TabsTrigger value="dark" aria-label={t('dark')} title={t('dark')}>
              <MoonIcon />
            </TabsTrigger>
            <TabsTrigger
              value="light"
              aria-label={t('light')}
              title={t('light')}
            >
              <SunIcon />
            </TabsTrigger>
          </TabsList>
        </Tabs>
      </EditorSection>
      <EditorSection label={t('colors')}>
        <ToggleGroup
            variant="strip"
            multiple={false}
            spacing={0}
            className="w-full"
            style={{ '--strip': stripBackground } as CSSVars}
            aria-label={t('gradient.colors')}
            value={stripSelected === null ? [] : [String(stripSelected)]}
            onValueChange={(next) => {
              const picked = next[0]
              if (typeof picked !== 'string') return
              setSelection(
                gradient
                  ? { kind: 'gradient', index: Number(picked) }
                  : { kind: 'anchor', key: 'accent' },
              )
            }}
          >
            {stripColors.map((_, index) => (
              <ToggleGroupItem
                key={index}
                value={String(index)}
                aria-label={
                  gradient
                    ? t('gradient.colorStop', { index: index + 1 })
                    : t('accent')
                }
                size="swatch"
              >
                {index === stripSelected ? (
                  // Picked stop: rounded square with a pointer, outline only so the gradient shows through.
                  <svg
                    aria-hidden
                    viewBox="0 0 36 36"
                    className="size-9 shrink-0 text-on-media drop-shadow-md"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinejoin="round"
                  >
                    <path d="M10 3h16a6 6 0 0 1 6 6v14a6 6 0 0 1-6 6h-5L18 33.5 15 29h-5a6 6 0 0 1-6-6V9a6 6 0 0 1 6-6z" />
                  </svg>
                ) : (
                  <span
                    aria-hidden
                    className="size-6 shrink-0 rounded-md border-2 border-on-media drop-shadow-md"
                  />
                )}
              </ToggleGroupItem>
            ))}
        </ToggleGroup>
        <ThemeColorPicker
          key={`${draft.variant}:${selected.kind === 'anchor' ? selected.key : selected.index}`}
          value={color}
          onChange={changeColor}
          onRemove={
            gradient && selected.kind === 'gradient' ? removeColor : undefined
          }
        />
        {advanced ? (
          <ToggleGroup
            variant="outline"
            size="sm"
            multiple={false}
            className="w-full"
            aria-label={t('colors')}
            value={selected.kind === 'anchor' ? [selected.key] : []}
            onValueChange={(next) => {
              const key = next[0]
              if (typeof key === 'string' && isAnchorKey(key))
                setSelection({ kind: 'anchor', key })
            }}
          >
            {ANCHOR_KEYS.map((key) => (
              <ToggleGroupItem
                key={key}
                value={key}
                aria-label={t(key)}
                className="min-w-0 flex-1 gap-2"
              >
                <span
                  aria-hidden
                  className="size-3 shrink-0 rounded-full border border-border bg-(--swatch-color)"
                  style={{ '--swatch-color': activeAnchors[key] } as CSSVars}
                />
                <span className="truncate">{t(key)}</span>
              </ToggleGroupItem>
            ))}
          </ToggleGroup>
        ) : null}
        <Button
          type="button"
          variant="secondary"
          className="w-full"
          disabled={!canAdd}
          onClick={addColor}
        >
          <PlusIcon />
          {t('addColor')}
        </Button>
      </EditorSection>
      <EditorSection label={t('settings')}>
        <SliderField
          label={t('contrast')}
          value={activeAnchors.contrast}
          unit="%"
          stops={CONTRAST_STOPS}
          onChange={(value) => draft.setAnchor('contrast', value)}
        />
        {gradient ? (
          <>
            <SliderField
              label={t('gradient.angle')}
              value={gradient.angle}
              unit="°"
              stops={ANGLE_STOPS}
              onChange={(angle) =>
                draft.setAnchor('gradient', { ...gradient, angle })
              }
            />
            <SliderField
              label={t('gradient.mix')}
              value={gradient.mix}
              unit="%"
              stops={MIX_STOPS}
              onChange={(mix) =>
                draft.setAnchor('gradient', { ...gradient, mix })
              }
            />
          </>
        ) : null}
      </EditorSection>
      {showPreview ? (
        <Collapsible>
          <CollapsibleTrigger
            render={
              <Button
                type="button"
                variant="ghost"
                className="w-full justify-between"
              />
            }
          >
            {t('preview')}
            <ChevronDownIcon />
          </CollapsibleTrigger>
          <CollapsibleContent>
            <div className="pt-2">
              <ThemePreviewMini
                theme={draft.previewTheme}
                variant={draft.variant}
              />
            </div>
          </CollapsibleContent>
        </Collapsible>
      ) : null}
    </FieldGroup>
  )
}

export type ThemeEditorSubmit = {
  name: string
  anchors: AppearanceCustomTheme['anchors']
}
