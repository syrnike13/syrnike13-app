import { useCallback, useEffect, useMemo, useState } from 'react'
import { Option, Schema } from 'effect'
import {
  cloneAppearanceThemeAnchors,
  normalizeAppearanceThemeAnchors,
} from '@syrnike13/platform'
import {
  THEME_CATALOG,
  applyThemeToDocument,
  readSystemPrefersDark,
  type PrismAnchors,
  type PrismGradient,
  type ThemeVariant,
} from '@syrnike13/ui/tokens'
import { applyAppearanceTheme } from '#/features/appearance/appearance-themes'
import { useAppearance } from '#/features/appearance/appearance-context'

const STORAGE_KEY = 'syrnike13-prism-workbench:v1'
const UnknownRecord = Schema.Record(Schema.String, Schema.Unknown)
export const ANCHOR_KEYS = ['accent', 'background', 'foreground'] as const
export type PrismAnchorColorKey = (typeof ANCHOR_KEYS)[number]
export type ThemeAnchors = Record<ThemeVariant, PrismAnchors>
export type ThemeWorkbenchEntry = {
  id: string
  origin: 'catalog' | 'added'
  anchors: ThemeAnchors
}
export type AddThemeResult = 'added' | 'invalid' | 'duplicate'
const THEME_ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

function cloneAnchors(anchors: ThemeAnchors): ThemeAnchors {
  return {
    light: cloneAppearanceThemeAnchors(anchors.light),
    dark: cloneAppearanceThemeAnchors(anchors.dark),
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
export function normalizeColorHex(value: string): string | null {
  const match = value.trim().match(/^#?([0-9a-f]{3}|[0-9a-f]{6})$/i)
  if (!match) return null
  const digits = match[1]!
  return `#${(digits.length === 3 ? [...digits].map((d) => d + d).join('') : digits).toLowerCase()}`
}
function normalizeThemeId(value: string): string | null {
  const normalized = value.trim().toLowerCase()
  return THEME_ID_PATTERN.test(normalized) ? normalized : null
}
export function suggestThemeId(themes: readonly ThemeWorkbenchEntry[]): string {
  let index = themes.length + 1
  while (themes.some((theme) => theme.id === `theme-${index}`)) index += 1
  return `theme-${index}`
}
export function themeIsModified(theme: ThemeWorkbenchEntry): boolean {
  const catalogTheme = THEME_CATALOG.find((entry) => entry.id === theme.id)
  return (
    theme.origin === 'added' ||
    !catalogTheme ||
    JSON.stringify(theme.anchors).toLowerCase() !==
      JSON.stringify(catalogTheme.anchors).toLowerCase()
  )
}
function readStoredWorkbench(fallbackThemeId: string) {
  const themes = createCatalogThemes()
  let selectedThemeId = fallbackThemeId
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY)
    const parsed: unknown = raw ? JSON.parse(raw) : null
    const decoded = Schema.decodeUnknownOption(UnknownRecord)(parsed)
    if (Option.isSome(decoded)) {
      const record = decoded.value
      if (Array.isArray(record.themes)) {
        for (const value of record.themes) {
          const entry = Schema.decodeUnknownOption(UnknownRecord)(value)
          if (Option.isNone(entry)) continue
          const id =
            typeof entry.value.id === 'string'
              ? normalizeThemeId(entry.value.id)
              : null
          const variants = Schema.decodeUnknownOption(UnknownRecord)(
            entry.value.anchors,
          )
          if (!id || Option.isNone(variants)) continue
          const light = normalizeAppearanceThemeAnchors(variants.value.light)
          const dark = normalizeAppearanceThemeAnchors(variants.value.dark)
          if (!light || !dark) continue
          const existing = themes.find((theme) => theme.id === id)
          if (existing) existing.anchors = { light, dark }
          else if (entry.value.origin === 'added')
            themes.push({ id, origin: 'added', anchors: { light, dark } })
        }
      }
      if (typeof record.selectedThemeId === 'string')
        selectedThemeId = record.selectedThemeId
    }
  } catch {
    /* private mode / corrupt storage */
  }
  if (!themes.some((theme) => theme.id === selectedThemeId))
    selectedThemeId = themes[0]!.id
  return { themes, selectedThemeId }
}

/** Public Prism anchors only: the package owns all surface coefficients. */
export function usePrismWorkbench(active: boolean) {
  const { settings, resolvedVariant } = useAppearance()
  const [fallbackThemeId] = useState(settings.themeIds[resolvedVariant])
  const [themes, setThemes] = useState(createCatalogThemes)
  const [selectedThemeId, setSelectedThemeId] = useState(fallbackThemeId)
  const [restored, setRestored] = useState(false)
  const [previewVariant, setPreviewVariant] = useState<ThemeVariant | null>(
    null,
  )
  const selectedTheme =
    themes.find((theme) => theme.id === selectedThemeId) ?? themes[0]!
  const activeVariant = previewVariant ?? resolvedVariant

  // Match the server's first render, then restore drafts before enabling persistence.
  useEffect(() => {
    const stored = readStoredWorkbench(fallbackThemeId)
    setThemes(stored.themes)
    setSelectedThemeId(stored.selectedThemeId)
    setRestored(true)
  }, [fallbackThemeId])

  useEffect(() => {
    if (!restored) return
    try {
      window.localStorage.setItem(
        STORAGE_KEY,
        JSON.stringify({
          themes: themes.filter(themeIsModified),
          selectedThemeId,
        }),
      )
    } catch {
      /* private mode */
    }
  }, [themes, selectedThemeId, restored])

  useEffect(() => {
    if (!restored) return
    const frame = window.requestAnimationFrame(() => {
      if (!active) {
        applyAppearanceTheme(settings)
        return
      }
      applyThemeToDocument(
        { ...settings, gradient: null, colorMode: activeVariant },
        readSystemPrefersDark(),
        selectedTheme,
      )
    })
    return () => window.cancelAnimationFrame(frame)
  }, [active, activeVariant, selectedTheme, settings, restored])

  const updateAnchors = useCallback(
    (
      variant: ThemeVariant,
      update: (anchors: PrismAnchors) => PrismAnchors,
    ) => {
      setThemes((current) =>
        current.map((theme) =>
          theme.id === selectedThemeId
            ? {
                ...theme,
                anchors: {
                  ...theme.anchors,
                  [variant]: update(theme.anchors[variant]),
                },
              }
            : theme,
        ),
      )
    },
    [selectedThemeId],
  )
  const setAnchorColor = useCallback(
    (variant: ThemeVariant, key: PrismAnchorColorKey, value: string) => {
      updateAnchors(variant, (anchors) => ({ ...anchors, [key]: value }))
    },
    [updateAnchors],
  )
  const setAnchorContrast = useCallback(
    (variant: ThemeVariant, value: number) => {
      updateAnchors(variant, (anchors) => ({
        ...anchors,
        contrast: clamp(value, 0, 100),
      }))
    },
    [updateAnchors],
  )
  const setGradient = useCallback(
    (variant: ThemeVariant, gradient: PrismGradient | undefined) => {
      updateAnchors(variant, ({ gradient: _previous, ...anchors }) =>
        gradient ? { ...anchors, gradient } : anchors,
      )
    },
    [updateAnchors],
  )
  const addTheme = useCallback(
    (value: string): AddThemeResult => {
      const id = normalizeThemeId(value)
      if (!id) return 'invalid'
      if (themes.some((theme) => theme.id === id)) return 'duplicate'
      setThemes((current) => [
        ...current,
        { id, origin: 'added', anchors: cloneAnchors(selectedTheme.anchors) },
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
    const original = THEME_CATALOG.find((theme) => theme.id === selectedThemeId)
    if (!original) return
    setThemes((current) =>
      current.map((theme) =>
        theme.id === selectedThemeId
          ? { ...theme, anchors: cloneAnchors(original.anchors) }
          : theme,
      ),
    )
  }, [selectedThemeId])
  const resetAll = useCallback(() => {
    const next = createCatalogThemes()
    setThemes(next)
    if (!next.some((theme) => theme.id === selectedThemeId))
      setSelectedThemeId(next[0]!.id)
  }, [selectedThemeId])
  const isCustom = useMemo(() => themes.some(themeIsModified), [themes])
  return {
    themes,
    selectedTheme,
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
    setGradient,
    isCustom,
  }
}
