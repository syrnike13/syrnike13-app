export const APP_LOCALES = ['en', 'ru'] as const

export type AppLocale = (typeof APP_LOCALES)[number]

export type Messages = {
  [key: string]: string | Messages
}

export type MessageCatalogs = Record<AppLocale, Messages>

export type TranslateValues = Record<
  string,
  string | number | boolean | null | undefined
>
