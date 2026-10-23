import { render, type RenderOptions } from '@testing-library/react'
import type { ReactElement } from 'react'

import {
  LocaleProvider,
  UI_MESSAGES,
  mergeMessages,
  type AppLocale,
  type Messages,
} from '../i18n'

type RenderWithI18nOptions = RenderOptions & {
  locale?: AppLocale
  messages?: Partial<Record<AppLocale, Messages>>
}

export function renderWithI18n(
  ui: ReactElement,
  { locale = 'ru', messages, ...options }: RenderWithI18nOptions = {},
) {
  const catalogs = {
    en: mergeMessages(UI_MESSAGES.en, messages?.en),
    ru: mergeMessages(UI_MESSAGES.ru, messages?.ru),
  }

  return render(
    <LocaleProvider catalogs={catalogs} defaultLocale={locale}>
      {ui}
    </LocaleProvider>,
    options,
  )
}
