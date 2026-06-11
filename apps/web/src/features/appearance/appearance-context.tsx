import type { AppearanceColorMode, AppearanceSettings } from '@syrnike13/platform'
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react'

import {
  applyThemeToDocument,
  readSystemPrefersDark,
} from '#/features/appearance/apply-theme'
import { appearanceSettingsStore } from '#/features/appearance/appearance-settings-store'
import {
  listThemes,
  resolveThemeVariant,
  type ThemeDefinition,
  type ThemeVariant,
} from '#/features/appearance/theme-registry'

type AppearanceContextValue = {
  settings: AppearanceSettings
  resolvedVariant: ThemeVariant
  themes: ThemeDefinition[]
  setThemeId: (themeId: string) => void
  setColorMode: (colorMode: AppearanceColorMode) => void
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
    applyThemeToDocument(settings, prefersDark)
  }, [settings, prefersDark])

  useEffect(() => {
    const media = window.matchMedia('(prefers-color-scheme: dark)')
    const onChange = () => setPrefersDark(media.matches)
    media.addEventListener('change', onChange)
    return () => media.removeEventListener('change', onChange)
  }, [])

  const setThemeId = useCallback((themeId: string) => {
    appearanceSettingsStore.setThemeId(themeId)
  }, [])

  const setColorMode = useCallback((colorMode: AppearanceColorMode) => {
    appearanceSettingsStore.setColorMode(colorMode)
  }, [])

  const resolvedVariant = useMemo(
    () => resolveThemeVariant(settings, prefersDark),
    [settings, prefersDark],
  )

  const value = useMemo<AppearanceContextValue>(
    () => ({
      settings,
      resolvedVariant,
      themes: listThemes(),
      setThemeId,
      setColorMode,
    }),
    [settings, resolvedVariant, setThemeId, setColorMode],
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
