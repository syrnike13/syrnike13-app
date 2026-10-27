import { APPEARANCE_CUSTOM_THEME_NAME_MAX } from '@syrnike13/platform'
import type {
  AppearanceColorMode,
  AppearanceCustomTheme,
  AppearanceSettings,
  AppearanceThemeVariant,
} from '@syrnike13/platform'
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react'

import { readSystemPrefersDark } from '@syrnike13/ui/tokens'
import { appearanceSettingsStore } from '#/features/appearance/appearance-settings-store'
import {
  applyAppearanceTheme,
  createCustomThemeId,
  listAppearanceThemes,
} from '#/features/appearance/appearance-themes'
import {
  resolveThemeVariant,
  type ThemeDefinition,
  type ThemeVariant,
} from '@syrnike13/ui/tokens'

type AppearanceContextValue = {
  settings: AppearanceSettings
  resolvedVariant: ThemeVariant
  /** Каталожные темы, затем пользовательские. */
  themes: ThemeDefinition[]
  /** Пользовательские темы: их можно править, дублировать и удалять. */
  customThemes: AppearanceCustomTheme[]
  setThemeId: (themeId: string, variant?: AppearanceThemeVariant) => void
  setColorMode: (colorMode: AppearanceColorMode) => void
  setScale: (scale: number) => void
  createCustomTheme: (theme: AppearanceCustomTheme) => void
  updateCustomTheme: (
    themeId: string,
    update: (theme: AppearanceCustomTheme) => AppearanceCustomTheme,
  ) => void
  deleteCustomTheme: (themeId: string) => void
  duplicateCustomTheme: (themeId: string, nameSuffix?: string) => string | null
}

const AppearanceContext = createContext<AppearanceContextValue | null>(null)

export function AppearanceProvider({ children }: { children: ReactNode }) {
  const [settings, setSettings] = useState(() =>
    appearanceSettingsStore.getState(),
  )
  const [prefersDark, setPrefersDark] = useState(() => readSystemPrefersDark())

  useEffect(() => {
    return appearanceSettingsStore.subscribe(() => {
      setSettings(appearanceSettingsStore.getState())
    })
  }, [])

  useEffect(() => {
    applyAppearanceTheme(settings, prefersDark)
  }, [settings, prefersDark])

  useEffect(() => {
    const media = window.matchMedia('(prefers-color-scheme: dark)')
    const onChange = () => setPrefersDark(media.matches)
    media.addEventListener('change', onChange)
    return () => media.removeEventListener('change', onChange)
  }, [])

  const setThemeId = useCallback(
    (themeId: string, variant?: AppearanceThemeVariant) => {
      appearanceSettingsStore.setThemeId(themeId, variant)
    },
    [],
  )

  const setColorMode = useCallback((colorMode: AppearanceColorMode) => {
    appearanceSettingsStore.setColorMode(colorMode)
  }, [])

  const setScale = useCallback((scale: number) => {
    appearanceSettingsStore.setScale(scale)
  }, [])

  const createCustomTheme = useCallback((theme: AppearanceCustomTheme) => {
    appearanceSettingsStore.addCustomTheme(theme)
    const variant = resolveThemeVariant(
      appearanceSettingsStore.getState(),
      readSystemPrefersDark(),
    )
    appearanceSettingsStore.setThemeId(theme.id, variant)
  }, [])

  const updateCustomTheme = useCallback(
    (
      themeId: string,
      update: (theme: AppearanceCustomTheme) => AppearanceCustomTheme,
    ) => {
      appearanceSettingsStore.updateCustomTheme(themeId, update)
    },
    [],
  )

  const deleteCustomTheme = useCallback((themeId: string) => {
    appearanceSettingsStore.removeCustomTheme(themeId)
  }, [])

  const duplicateCustomTheme = useCallback(
    (themeId: string, nameSuffix = ''): string | null => {
      const source = appearanceSettingsStore
        .getState()
        .customThemes.find((theme) => theme.id === themeId)
      if (!source) return null
      const copy: AppearanceCustomTheme = {
        ...source,
        id: createCustomThemeId(),
        name: `${source.name}${nameSuffix}`.slice(0, APPEARANCE_CUSTOM_THEME_NAME_MAX),
        anchors: {
          light: { ...source.anchors.light },
          dark: { ...source.anchors.dark },
        },
      }
      appearanceSettingsStore.addCustomTheme(copy)
      return copy.id
    },
    [],
  )

  const resolvedVariant = useMemo(
    () => resolveThemeVariant(settings, prefersDark),
    [settings, prefersDark],
  )

  const themes = useMemo(() => listAppearanceThemes(settings), [settings])

  const customThemes = settings.customThemes

  const value = useMemo<AppearanceContextValue>(
    () => ({
      settings,
      resolvedVariant,
      themes,
      customThemes,
      setThemeId,
      setColorMode,
      setScale,
      createCustomTheme,
      updateCustomTheme,
      deleteCustomTheme,
      duplicateCustomTheme,
    }),
    [
      createCustomTheme,
      customThemes,
      deleteCustomTheme,
      duplicateCustomTheme,
      resolvedVariant,
      setColorMode,
      setScale,
      setThemeId,
      settings,
      themes,
      updateCustomTheme,
    ],
  )

  return (
    <AppearanceContext.Provider value={value}>{children}</AppearanceContext.Provider>
  )
}

export function useAppearance() {
  const context = useContext(AppearanceContext)
  if (!context) {
    throw new Error('useAppearance must be used within AppearanceProvider')
  }
  return context
}
