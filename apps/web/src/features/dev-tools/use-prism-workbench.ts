import { useCallback, useEffect, useMemo, useState } from 'react'

import {
  DEFAULT_PRISM_TUNING,
  THEME_CATALOG,
  applyThemeToDocument,
  readSystemPrefersDark,
  type PrismAnchors,
  type PrismSurfaceMixKey,
  type PrismTuning,
  type ThemeVariant,
} from '@syrnike13/ui/tokens'

import { useAppearance } from '#/features/appearance/appearance-context'

const STORAGE_KEY = 'syrnike13-prism-workbench:v1'

export const SURFACE_KEYS: readonly PrismSurfaceMixKey[] = [
  'card',
  'popover',
  'secondary',
  'muted',
  'input',
  'sidebar',
  'border',
  'accent',
  'hover',
  'selection',
]

export const SURFACE_LABELS: Record<PrismSurfaceMixKey, string> = {
  card: 'Card',
  popover: 'Popover',
  secondary: 'Secondary',
  muted: 'Muted',
  input: 'Input surface',
  sidebar: 'Sidebar',
  border: 'Border / divider',
  accent: 'Accent fill',
  hover: 'Hover fill',
  selection: 'Selection',
}

/** Anchor colors exposed as editable fields; `contrast` gets its own slider. */
export const ANCHOR_KEYS = ['accent', 'background', 'foreground'] as const

export type PrismAnchorColorKey = (typeof ANCHOR_KEYS)[number]

export type ThemeAnchors = Record<ThemeVariant, PrismAnchors>

export type ThemeWorkbenchEntry = {
  id: string
  /** `added` themes exist only in the workbench until exported into the catalog. */
  origin: 'catalog' | 'added'
  anchors: ThemeAnchors
}

export type AddThemeResult = 'added' | 'invalid' | 'duplicate'

type InitialWorkbench = {
  themes: ThemeWorkbenchEntry[]
  tuning: PrismTuning
  selectedThemeId: string
}

const THEME_ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

function cloneAnchors(anchors: ThemeAnchors): ThemeAnchors {
  return {
    light: { ...anchors.light },
    dark: { ...anchors.dark },
  }
}

function cloneTuning(): PrismTuning {
  return {
    surfaceMix: { ...DEFAULT_PRISM_TUNING.surfaceMix },
    raisedMix: { ...DEFAULT_PRISM_TUNING.raisedMix },
    minInteractionDelta: { ...DEFAULT_PRISM_TUNING.minInteractionDelta },
  }
}

function createCatalogThemes(): ThemeWorkbenchEntry[] {
  return THEME_CATALOG.map((theme) => ({
    id: theme.id,
    origin: 'catalog',
    anchors: cloneAnchors(theme.anchors),
  }))
}

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value))
}

const HEX_COLOR_PATTERN = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i

/** Accepts `#rgb` / `#rrggbb` and returns the lowercase catalog form. */
export function normalizeColorHex(value: string): string | null {
  const match = value.trim().match(HEX_COLOR_PATTERN)
  if (!match) return null
  const digits = match[1]!
  const expanded =
    digits.length === 3
      ? digits
          .split('')
          .map((digit) => digit + digit)
          .join('')
      : digits
  return `#${expanded.toLowerCase()}`
}

function normalizeThemeId(value: string): string | null {
  const normalized = value.trim().toLowerCase()
  return THEME_ID_PATTERN.test(normalized) ? normalized : null
}

export function suggestThemeId(themes: readonly ThemeWorkbenchEntry[]): string {
  let index = themes.length + 1
  while (themes.some((theme) => theme.id === `theme-${index}`)) {
    index += 1
  }
  return `theme-${index}`
}

export function themeIsModified(theme: ThemeWorkbenchEntry): boolean {
  if (theme.origin === 'added') return true
  const catalogTheme = THEME_CATALOG.find((entry) => entry.id === theme.id)
  return !catalogTheme || !sameAnchors(theme.anchors, catalogTheme.anchors)
}

function sameAnchors(a: ThemeAnchors, b: ThemeAnchors) {
  return (['light', 'dark'] as const).every((variant) =>
    (['accent', 'background', 'foreground', 'contrast'] as const).every(
      (key) => a[variant][key] === b[variant][key],
    ),
  )
}

function sanitizeTuning(value: unknown): PrismTuning {
  const base = cloneTuning()
  if (!value || typeof value !== 'object') return base
  const record = value as Record<string, unknown>

  const surfaceMix = record.surfaceMix
  if (surfaceMix && typeof surfaceMix === 'object') {
    for (const key of SURFACE_KEYS) {
      const entry = (surfaceMix as Record<string, unknown>)[key]
      if (typeof entry === 'number' && Number.isFinite(entry)) {
        base.surfaceMix[key] = clamp(entry, 0, 60)
      }
    }
  }

  const raisedMix = record.raisedMix
  if (raisedMix && typeof raisedMix === 'object') {
    for (const mode of ['light', 'dark'] as const) {
      const entry = (raisedMix as Record<string, unknown>)[mode]
      if (typeof entry === 'number' && Number.isFinite(entry)) {
        base.raisedMix[mode] = clamp(entry, 0, 60)
      }
    }
  }

  const deltas = record.minInteractionDelta
  if (deltas && typeof deltas === 'object') {
    for (const key of ['accent', 'hover'] as const) {
      const entry = (deltas as Record<string, unknown>)[key]
      if (typeof entry === 'number' && Number.isFinite(entry)) {
        base.minInteractionDelta[key] = clamp(entry, 0, 0.3)
      }
    }
  }

  return base
}

function sanitizeAnchors(value: unknown): ThemeAnchors | null {
  if (!value || typeof value !== 'object') return null
  const record = value as Record<string, unknown>
  const anchors = {} as ThemeAnchors

  for (const variant of ['light', 'dark'] as const) {
    const raw = record[variant]
    if (!raw || typeof raw !== 'object') return null
    const entry = raw as Record<string, unknown>
    const accent =
      typeof entry.accent === 'string'
        ? normalizeColorHex(entry.accent)
        : null
    const background =
      typeof entry.background === 'string'
        ? normalizeColorHex(entry.background)
        : null
    const foreground =
      typeof entry.foreground === 'string'
        ? normalizeColorHex(entry.foreground)
        : null
    const contrast =
      typeof entry.contrast === 'number' && Number.isFinite(entry.contrast)
        ? clamp(entry.contrast, 0, 100)
        : null
    if (!accent || !background || !foreground || contrast === null) return null
    anchors[variant] = { accent, background, foreground, contrast }
  }

  return anchors
}

function pickSelectedThemeId(
  candidates: readonly string[],
  themes: readonly ThemeWorkbenchEntry[],
): string {
  const match = candidates.find(
    (candidate) =>
      candidate.length > 0 && themes.some((theme) => theme.id === candidate),
  )
  return match ?? themes[0]!.id
}

/**
 * Merge stored workbench edits over the catalog.
 *
 * Only modified catalog themes and added themes are persisted, so catalog
 * changes made in code still arrive on reload; Reset all drops everything.
 */
function readStoredWorkbench(fallbackThemeId: string): InitialWorkbench {
  const themes = createCatalogThemes()
  const tuning = cloneTuning()

  if (typeof window !== 'undefined') {
    try {
      const raw = window.localStorage.getItem(STORAGE_KEY)
      if (raw) {
        const parsed = JSON.parse(raw) as unknown
        if (parsed && typeof parsed === 'object') {
          const record = parsed as Record<string, unknown>
          const storedTuning = sanitizeTuning(record.tuning)
          Object.assign(tuning, storedTuning)

          const storedThemes = Array.isArray(record.themes)
            ? record.themes
            : []
          for (const value of storedThemes) {
            if (!value || typeof value !== 'object') continue
            const entry = value as Record<string, unknown>
            const id =
              typeof entry.id === 'string' ? normalizeThemeId(entry.id) : null
            const anchors = sanitizeAnchors(entry.anchors)
            if (!id || !anchors) continue
            const catalogTheme = themes.find((theme) => theme.id === id)
            if (catalogTheme) {
              catalogTheme.anchors = anchors
            } else if (entry.origin === 'added') {
              themes.push({ id, origin: 'added', anchors })
            }
          }

          const storedSelected =
            typeof record.selectedThemeId === 'string'
              ? record.selectedThemeId
              : ''
          return {
            themes,
            tuning,
            selectedThemeId: pickSelectedThemeId(
              [storedSelected, fallbackThemeId],
              themes,
            ),
          }
        }
      }
    } catch {
      // private mode / corrupt storage
    }
  }

  return {
    themes,
    tuning,
    selectedThemeId: pickSelectedThemeId([fallbackThemeId], themes),
  }
}

/**
 * Dev-only theme workbench: every catalog theme, added drafts and Prism tuning.
 *
 * The selected theme and mode are previewed only while the workbench is
 * active; closing the panel or switching tabs restores the saved appearance.
 * Edits persist locally.
 */
export function usePrismWorkbench(active: boolean) {
  const { settings, resolvedVariant } = useAppearance()
  const [initial] = useState(() => readStoredWorkbench(settings.themeId))
  const [themes, setThemes] = useState<ThemeWorkbenchEntry[]>(initial.themes)
  const [tuning, setTuning] = useState<PrismTuning>(initial.tuning)
  const [selectedThemeId, setSelectedThemeId] = useState(
    initial.selectedThemeId,
  )
  // Panel-only preview: force a mode without changing the saved appearance.
  const [previewVariant, setPreviewVariant] = useState<ThemeVariant | null>(null)

  const selectedTheme =
    themes.find((theme) => theme.id === selectedThemeId) ?? themes[0]!
  const activeVariant = previewVariant ?? resolvedVariant

  useEffect(() => {
    try {
      window.localStorage.setItem(
        STORAGE_KEY,
        JSON.stringify({
          themes: themes
            .filter(themeIsModified)
            .map(({ id, origin, anchors }) => ({ id, origin, anchors })),
          tuning,
          selectedThemeId,
        }),
      )
    } catch {
      // private mode
    }
  }, [selectedThemeId, themes, tuning])

  // The workbench preview lives only while its tab is open: switching tabs or
  // closing the panel restores the saved appearance, while the edits stay in
  // localStorage.
  useEffect(() => {
    const frame = window.requestAnimationFrame(() => {
      if (!active) {
        applyThemeToDocument(settings)
        return
      }
      applyThemeToDocument(
        {
          ...settings,
          themeId: selectedTheme.id,
          colorMode: activeVariant,
        },
        readSystemPrefersDark(),
        tuning,
        selectedTheme.anchors,
      )
    })
    return () => window.cancelAnimationFrame(frame)
  }, [active, activeVariant, selectedTheme, settings, tuning])

  const setAnchorColor = useCallback(
    (variant: ThemeVariant, key: PrismAnchorColorKey, value: string) => {
      setThemes((current) =>
        current.map((theme) =>
          theme.id === selectedThemeId
            ? {
                ...theme,
                anchors: {
                  ...theme.anchors,
                  [variant]: { ...theme.anchors[variant], [key]: value },
                },
              }
            : theme,
        ),
      )
    },
    [selectedThemeId],
  )

  const setAnchorContrast = useCallback(
    (variant: ThemeVariant, value: number) => {
      setThemes((current) =>
        current.map((theme) =>
          theme.id === selectedThemeId
            ? {
                ...theme,
                anchors: {
                  ...theme.anchors,
                  [variant]: {
                    ...theme.anchors[variant],
                    contrast: clamp(value, 0, 100),
                  },
                },
              }
            : theme,
        ),
      )
    },
    [selectedThemeId],
  )

  const addTheme = useCallback(
    (value: string): AddThemeResult => {
      const id = normalizeThemeId(value)
      if (!id) return 'invalid'
      if (themes.some((theme) => theme.id === id)) return 'duplicate'
      setThemes((current) => [
        ...current,
        {
          id,
          origin: 'added',
          anchors: cloneAnchors(selectedTheme.anchors),
        },
      ])
      setSelectedThemeId(id)
      return 'added'
    },
    [selectedTheme.anchors, themes],
  )

  const removeSelectedTheme = useCallback(() => {
    if (selectedTheme.origin !== 'added') return
    const next = themes.filter((theme) => theme.id !== selectedTheme.id)
    setThemes(next)
    setSelectedThemeId(next[0]!.id)
  }, [selectedTheme, themes])

  const restoreSelectedTheme = useCallback(() => {
    const catalogTheme = THEME_CATALOG.find(
      (theme) => theme.id === selectedTheme.id,
    )
    if (!catalogTheme) return
    setThemes((current) =>
      current.map((theme) =>
        theme.id === selectedTheme.id
          ? { ...theme, anchors: cloneAnchors(catalogTheme.anchors) }
          : theme,
      ),
    )
  }, [selectedTheme.id])

  const resetAll = useCallback(() => {
    const next = createCatalogThemes()
    setThemes(next)
    setTuning(cloneTuning())
    if (!next.some((theme) => theme.id === selectedThemeId)) {
      setSelectedThemeId(next[0]!.id)
    }
  }, [selectedThemeId])

  const isCustom = useMemo(
    () =>
      themes.some(themeIsModified) ||
      JSON.stringify(tuning) !== JSON.stringify(DEFAULT_PRISM_TUNING),
    [themes, tuning],
  )

  return {
    themes,
    selectedTheme,
    tuning,
    setTuning,
    previewVariant,
    activeVariant,
    setPreviewVariant,
    selectTheme: setSelectedThemeId,
    addTheme,
    removeSelectedTheme,
    restoreSelectedTheme,
    resetAll,
    setAnchorColor,
    setAnchorContrast,
    isCustom,
  }
}
