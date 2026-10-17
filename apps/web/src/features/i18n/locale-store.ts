import { APP_LOCALES, type AppLocale } from '@syrnike13/ui/i18n'

const STORAGE_KEY = 'syrnike13-locale'

export function isAppLocale(value: string | null): value is AppLocale {
  return value !== null && APP_LOCALES.includes(value as AppLocale)
}

export function readStoredLocale(): AppLocale | null {
  if (typeof window === 'undefined') return null
  try {
    const stored = window.localStorage.getItem(STORAGE_KEY)
    return isAppLocale(stored) ? stored : null
  } catch {
    return null
  }
}

export function detectLocale(): AppLocale {
  const stored = readStoredLocale()
  if (stored) return stored

  if (typeof navigator !== 'undefined') {
    const language = navigator.language?.toLowerCase() ?? ''
    if (language.startsWith('ru')) return 'ru'
    if (language.startsWith('en')) return 'en'
  }

  return 'ru'
}

export function persistLocale(locale: AppLocale) {
  if (typeof window === 'undefined') return
  try {
    window.localStorage.setItem(STORAGE_KEY, locale)
  } catch {
    // Storage can be unavailable in private contexts; locale still works in memory.
  }
}
