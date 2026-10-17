import { useEffect, useState, type ReactNode } from 'react'
import { LocaleProvider, type AppLocale } from '@syrnike13/ui/i18n'

import en from '#/messages/en.json'
import ru from '#/messages/ru.json'

import { detectLocale, persistLocale } from './locale-store'

const CATALOGS = { en, ru }

export function AppLocaleProvider({ children }: { children: ReactNode }) {
  const [locale, setLocale] = useState<AppLocale>(() => detectLocale())

  useEffect(() => {
    persistLocale(locale)
  }, [locale])

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
