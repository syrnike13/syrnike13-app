import {
  APPEARANCE_CUSTOM_THEME_NAME_MAX,
  APPEARANCE_THEME_CONTRAST_MAX,
  type AppearanceCustomTheme,
  type AppearanceThemeAnchors,
  type AppearanceThemeVariant,
} from '@syrnike13/platform'
import { useTranslations } from '@syrnike13/ui/i18n'
import {
  Field,
  FieldDescription,
  FieldGroup,
  FieldLabel,
} from '@syrnike13/ui/primitives/field'
import { Input } from '@syrnike13/ui/primitives/input'
import { Tabs, TabsList, TabsTrigger } from '@syrnike13/ui/primitives/tabs'
import type { ThemeDefinition } from '@syrnike13/ui/tokens'
import { useRef, useState } from 'react'

import { PencilIcon } from '#/components/icons'
import { ThemeOrbPair } from '#/components/appearance/theme-orbs'
import { ThemePreviewMini } from '#/components/appearance/theme-preview-mini'
import { PresetSlider } from '#/components/ui/preset-slider'
import { anchorsForNewTheme } from '#/features/appearance/appearance-themes'
import type { CSSVars } from '#/lib/css-vars'

const CONTRAST_STOPS = [{ value: 0 }, { value: APPEARANCE_THEME_CONTRAST_MAX }]

const ANCHOR_KEYS = ['accent', 'background', 'foreground'] as const

function AnchorSwatch({
  label,
  value,
  onChange,
}: {
  label: string
  value: string
  onChange: (value: string) => void
}) {
  const inputRef = useRef<HTMLInputElement>(null)

  return (
    <div className="flex flex-col items-center gap-1">
      {/* eslint-disable-next-line design/no-lookalike -- образец цвета якоря Prism */}
      <button
        type="button"
        title={label}
        aria-label={label}
        className="relative size-11 shrink-0 appearance-none overflow-hidden rounded-lg border-2 border-border bg-(--swatch-color) p-0 transition-colors hover:border-foreground/40"
        style={{ '--swatch-color': value } as CSSVars}
        onClick={() => inputRef.current?.click()}
      >
        <span className="absolute top-1 right-1 flex size-4 items-center justify-center rounded-sm bg-scrim text-on-scrim">
          <PencilIcon className="size-2.5" />
        </span>
        {/* eslint-disable-next-line design/no-lookalike -- нативный color input под образцом */}
        <input
          ref={inputRef}
          type="color"
          className="sr-only"
          value={value}
          onChange={(event) => onChange(event.target.value.toUpperCase())}
        />
      </button>
      <span className="text-xs text-muted-foreground">{label}</span>
    </div>
  )
}

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
  /** Черновик как определение темы — для сфер и миниатюры. */
  previewTheme: ThemeDefinition
  canSubmit: boolean
}

export function useThemeDraft(
  initial: AppearanceCustomTheme | null,
  initialAnchors: AppearanceCustomTheme['anchors'] | null,
): ThemeEditorDraft {
  const [name, setName] = useState(initial?.name ?? '')
  const [variant, setVariant] = useState<AppearanceThemeVariant>('light')
  const [anchors, setAnchors] = useState<AppearanceCustomTheme['anchors']>(
    () =>
      initial
        ? {
            light: { ...initial.anchors.light },
            dark: { ...initial.anchors.dark },
          }
        : initialAnchors
          ? {
              light: { ...initialAnchors.light },
              dark: { ...initialAnchors.dark },
            }
          : anchorsForNewTheme(),
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
  }
}

/** Поля редактора темы: имя, вариант, якоря, контраст и живой предпросмотр. */
export function ThemeEditorFields({ draft }: { draft: ThemeEditorDraft }) {
  const t = useTranslations('settings.appearance.themeEditor')
  const activeAnchors = draft.anchors[draft.variant]

  return (
    <div className="flex flex-col gap-5 @md:flex-row @md:items-start">
      <FieldGroup className="min-w-0 flex-1 gap-4">
        <Field>
          <FieldLabel htmlFor="theme-name">{t('name')}</FieldLabel>
          <Input
            id="theme-name"
            value={draft.name}
            maxLength={APPEARANCE_CUSTOM_THEME_NAME_MAX}
            placeholder={t('namePlaceholder')}
            onChange={(event) => draft.setName(event.target.value)}
          />
        </Field>
        <Field>
          <FieldLabel>{t('variant')}</FieldLabel>
          <Tabs
            value={draft.variant}
            onValueChange={(value) =>
              draft.setVariant(value as AppearanceThemeVariant)
            }
          >
            <TabsList className="w-full">
              <TabsTrigger value="light">{t('light')}</TabsTrigger>
              <TabsTrigger value="dark">{t('dark')}</TabsTrigger>
            </TabsList>
          </Tabs>
        </Field>
        <Field>
          <FieldLabel>{t('colors')}</FieldLabel>
          <div className="flex gap-3">
            {ANCHOR_KEYS.map((key) => (
              <AnchorSwatch
                key={key}
                label={t(key)}
                value={activeAnchors[key]}
                onChange={(value) => draft.setAnchor(key, value)}
              />
            ))}
          </div>
          <FieldDescription>{t('colorsHint')}</FieldDescription>
        </Field>
        <Field>
          <FieldLabel htmlFor="theme-contrast">{t('contrast')}</FieldLabel>
          <PresetSlider
            aria-label={t('contrast')}
            mode="continuous"
            step={1}
            stops={CONTRAST_STOPS}
            value={activeAnchors.contrast}
            showLabels={false}
            showMarks={false}
            formatValue={(value) => `${value}%`}
            onValueChange={(value) => draft.setAnchor('contrast', value)}
          />
          <FieldDescription>{t('contrastHint')}</FieldDescription>
        </Field>
      </FieldGroup>
      <div className="flex shrink-0 flex-col items-center gap-3 self-stretch rounded-lg border border-border bg-card p-3 @md:self-start">
        <ThemeOrbPair theme={draft.previewTheme} />
        <div className="w-40">
          <ThemePreviewMini theme={draft.previewTheme} variant={draft.variant} />
        </div>
      </div>
    </div>
  )
}

export type ThemeEditorSubmit = {
  name: string
  anchors: AppearanceCustomTheme['anchors']
}
