import { useCallback, useEffect, useState, type ReactNode } from 'react'
import { LocaleProvider, type AppLocale } from '@syrnike13/ui/i18n'

import en from '#/messages/en.json'
import ru from '#/messages/ru.json'

import { detectLocale, persistLocale } from './locale-store'

const CATALOGS = { en, ru }
const DEFAULT_LOCALE: AppLocale = 'ru'

export function AppLocaleProvider({ children }: { children: ReactNode }) {
  // The server cannot know the stored/browser locale, so the first render is
  // always the default locale and detection happens after hydration.
  const [locale, setLocaleState] = useState<AppLocale>(DEFAULT_LOCALE)

  useEffect(() => {
    const detected = detectLocale()
    setLocaleState(detected)
    persistLocale(detected)
  }, [])

  const setLocale = useCallback((next: AppLocale) => {
    setLocaleState(next)
    persistLocale(next)
  }, [])

  return (
    <LocaleProvider
      catalogs={CATALOGS}
      locale={locale}
      onLocaleChange={setLocale}
    >
      {children}
    </LocaleProvider>
  )
}
