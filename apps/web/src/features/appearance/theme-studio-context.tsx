import type { AppearanceCustomTheme } from '@syrnike13/platform'
import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react'

export type ThemeStudioTarget =
  | { mode: 'create'; anchors: AppearanceCustomTheme['anchors']; nonce: number }
  | { mode: 'edit'; themeId: string; nonce: number }

type ThemeStudioContextValue = {
  target: ThemeStudioTarget | null
  /** Открывает редактор новой темы поверх основного экрана приложения. */
  openCreate: (anchors: AppearanceCustomTheme['anchors']) => void
  openEdit: (themeId: string) => void
  close: () => void
}

const ThemeStudioContext = createContext<ThemeStudioContextValue | null>(null)

/**
 * Редактор тем живёт вне окна настроек: панель справа сдвигает настоящий
 * интерфейс приложения, поэтому тему видно на живом чате.
 */
export function ThemeStudioProvider({ children }: { children: ReactNode }) {
  const [target, setTarget] = useState<ThemeStudioTarget | null>(null)
  const nonce = useRef(0)

  const openCreate = useCallback((anchors: AppearanceCustomTheme['anchors']) => {
    nonce.current += 1
    setTarget({ mode: 'create', anchors, nonce: nonce.current })
  }, [])

  const openEdit = useCallback((themeId: string) => {
    nonce.current += 1
    setTarget({ mode: 'edit', themeId, nonce: nonce.current })
  }, [])

  const close = useCallback(() => setTarget(null), [])

  const value = useMemo(
    () => ({ target, openCreate, openEdit, close }),
    [close, openCreate, openEdit, target],
  )

  return (
    <ThemeStudioContext.Provider value={value}>
      {children}
    </ThemeStudioContext.Provider>
  )
}

/** Безопасно для деревьев без провайдера (попауты, тесты): вернёт `null`. */
export function useThemeStudioTarget(): ThemeStudioTarget | null {
  return useContext(ThemeStudioContext)?.target ?? null
}

/** Безопасно для деревьев без провайдера: вернёт `null` вместо ошибки. */
export function useThemeStudioOptional(): ThemeStudioContextValue | null {
  return useContext(ThemeStudioContext)
}

export function useThemeStudio() {
  const context = useContext(ThemeStudioContext)
  if (!context) {
    throw new Error('useThemeStudio must be used within ThemeStudioProvider')
  }
  return context
}
