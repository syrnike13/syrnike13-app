import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react'

import en from './messages/en.json'
import ru from './messages/ru.json'
import {
  APP_LOCALES,
  type AppLocale,
  type MessageCatalogs,
  type Messages,
  type TranslateValues,
} from './types'

export const UI_MESSAGES: MessageCatalogs = { en, ru }

/**
 * Test-only fallback used when a component is rendered without a provider.
 * Apps register their own catalogs in the shared test setup.
 */
let defaultCatalogs: MessageCatalogs | null = null

export function configureDefaultCatalogs(catalogs: MessageCatalogs) {
  defaultCatalogs = catalogs
}

type LocaleContextValue = {
  locale: AppLocale
  setLocale: (locale: AppLocale) => void
  locales: readonly AppLocale[]
  messages: Messages
}

const LocaleContext = createContext<LocaleContextValue | null>(null)

export type LocaleProviderProps = {
  catalogs: MessageCatalogs
  children: ReactNode
  locale?: AppLocale
  defaultLocale?: AppLocale
  onLocaleChange?: (locale: AppLocale) => void
}

function mergeMessages(base: Messages, override?: Messages): Messages {
  if (!override) return base

  const merged: Messages = { ...base }
  for (const [key, value] of Object.entries(override)) {
    const current = merged[key]
    if (
      value &&
      typeof value === 'object' &&
      current &&
      typeof current === 'object'
    ) {
      merged[key] = mergeMessages(current, value)
    } else {
      merged[key] = value
    }
  }
  return merged
}

function getMessage(messages: Messages, key: string): string | undefined {
  let current: string | Messages | undefined = messages
  for (const part of key.split('.')) {
    if (!current || typeof current === 'string') return undefined
    current = current[part]
  }
  return typeof current === 'string' ? current : undefined
}

function selectPluralCase(
  locale: AppLocale,
  count: number,
  cases: Record<string, string>,
): string {
  const exact = cases[`=${count}`]
  if (exact !== undefined) return exact

  const category = new Intl.PluralRules(locale).select(count)
  return cases[category] ?? cases.other ?? ''
}

/** Minimal ICU subset: {name} interpolation and {count, plural, …}. */
export function formatMessage(
  message: string,
  values: TranslateValues,
  locale: AppLocale,
): string {
  const withPlurals = message.replace(
    /\{(\w+),\s*plural,\s*((?:(?:=\d+|zero|one|two|few|many|other)\s*\{[^{}]*\}\s*)+)\}/g,
    (match, variable: string, body: string) => {
      const count = Number(values[variable])
      if (!Number.isFinite(count)) return match

      const cases: Record<string, string> = {}
      for (const entry of body.matchAll(
        /(=\d+|zero|one|two|few|many|other)\s*\{([^{}]*)\}/g,
      )) {
        cases[entry[1]!] = entry[2]!
      }

      return selectPluralCase(locale, count, cases).replaceAll('#', String(count))
    },
  )

  return withPlurals.replace(/\{(\w+)\}/g, (match, name: string) => {
    const value = values[name]
    return value === undefined || value === null ? match : String(value)
  })
}

export function LocaleProvider({
  catalogs,
  children,
  locale,
  defaultLocale = 'ru',
  onLocaleChange,
}: LocaleProviderProps) {
  const [internalLocale, setInternalLocale] = useState<AppLocale>(defaultLocale)
  const currentLocale = locale ?? internalLocale

  const setLocale = useCallback(
    (next: AppLocale) => {
      if (!APP_LOCALES.includes(next)) return
      if (locale === undefined) setInternalLocale(next)
      onLocaleChange?.(next)
    },
    [locale, onLocaleChange],
  )

  useEffect(() => {
    if (typeof document !== 'undefined') {
      document.documentElement.lang = currentLocale
    }
  }, [currentLocale])

  const value = useMemo<LocaleContextValue>(
    () => ({
      locale: currentLocale,
      setLocale,
      locales: APP_LOCALES,
      messages: catalogs[currentLocale] ?? catalogs.ru,
    }),
    [catalogs, currentLocale, setLocale],
  )

  return (
    <LocaleContext.Provider value={value}>{children}</LocaleContext.Provider>
  )
}

function useLocaleContext(): LocaleContextValue {
  const context = useContext(LocaleContext)
  if (context) return context

  return {
    locale: 'ru',
    setLocale: () => {},
    locales: APP_LOCALES,
    messages:
      defaultCatalogs?.ru ?? mergeMessages(UI_MESSAGES.ru, UI_MESSAGES.en),
  }
}

export function useLocale() {
  const { locale, setLocale, locales } = useLocaleContext()
  return { locale, setLocale, locales }
}

export type Translator = {
  (key: string, values?: TranslateValues): string
  has: (key: string) => boolean
  raw: (key: string) => unknown
}

export function useTranslations(namespace?: string): Translator {
  const { locale, messages } = useLocaleContext()

  return useMemo(() => {
    const resolve = (key: string) =>
      namespace ? `${namespace}.${key}` : key

    const translate = ((key: string, values: TranslateValues = {}) => {
      const fullKey = resolve(key)
      const message = getMessage(messages, fullKey)
      return message === undefined
        ? fullKey
        : formatMessage(message, values, locale)
    }) as Translator

    translate.has = (key: string) => getMessage(messages, resolve(key)) !== undefined
    translate.raw = (key: string) => {
      let current: string | Messages | undefined = messages
      for (const part of resolve(key).split('.')) {
        if (!current || typeof current === 'string') return undefined
        current = current[part]
      }
      return current
    }

    return translate
  }, [locale, messages, namespace])
}

export { mergeMessages }
