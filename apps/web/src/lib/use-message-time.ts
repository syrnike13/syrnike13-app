import { useLocale, useTranslations } from '@syrnike13/ui/i18n'
import { useCallback } from 'react'

import {
  formatDateDividerDate,
  formatMessageTimeShort,
  formatMessageTimestamp,
  messageDayKind,
} from '#/lib/message-time'

/** Формат: «Сегодня в 19:44», «Вчера в 19:44», иначе полная дата. */
export function useMessageTimestamp() {
  const { locale } = useLocale()
  const t = useTranslations('chat')

  return useCallback(
    (date: Date) => {
      const kind = messageDayKind(date)
      if (kind === 'today' || kind === 'yesterday') {
        return t(kind === 'today' ? 'todayAt' : 'yesterdayAt', {
          time: formatMessageTimeShort(date, locale),
        })
      }
      return formatMessageTimestamp(date, locale)
    },
    [locale, t],
  )
}

export function useMessageTimeShort() {
  const { locale } = useLocale()
  return useCallback(
    (date: Date) => formatMessageTimeShort(date, locale),
    [locale],
  )
}

export function useDateDividerLabel() {
  const { locale } = useLocale()
  const t = useTranslations('chat')

  return useCallback(
    (date: Date) => {
      const kind = messageDayKind(date)
      if (kind === 'today') return t('today')
      if (kind === 'yesterday') return t('yesterday')
      return formatDateDividerDate(date, locale)
    },
    [locale, t],
  )
}
