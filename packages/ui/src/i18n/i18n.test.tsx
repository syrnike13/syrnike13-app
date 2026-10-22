// @vitest-environment jsdom

import { fireEvent, render, screen } from '@testing-library/react'
import { expect, test } from 'vitest'

import { formatMessage, useLocale, useTranslations } from './i18n'
import { renderWithI18n } from '../test-utils'

test('interpolates placeholders and handles Russian plural forms', () => {
  const message =
    '{count, plural, one {# файл} few {# файла} many {# файлов} other {# файла}} у {name}'

  expect(formatMessage(message, { count: 1, name: 'Ани' }, 'ru')).toBe(
    '1 файл у Ани',
  )
  expect(formatMessage(message, { count: 2, name: 'Ани' }, 'ru')).toBe(
    '2 файла у Ани',
  )
  expect(formatMessage(message, { count: 5, name: 'Ани' }, 'ru')).toBe(
    '5 файлов у Ани',
  )
  expect(formatMessage(message, { count: 21, name: 'Ани' }, 'ru')).toBe(
    '21 файл у Ани',
  )
})

function LocaleProbe() {
  const { locale, setLocale } = useLocale()
  const t = useTranslations('greet')

  return (
    <div>
      <span>{t('hello', { name: 'Аня' })}</span>
      <span>{locale}</span>
      <span>{t.has('missing') ? 'has' : 'missing'}</span>
      <button type="button" onClick={() => setLocale('en')}>
        switch
      </button>
    </div>
  )
}

test('provides translations, locale state and missing-key behavior', () => {
  renderWithI18n(<LocaleProbe />, {
    locale: 'ru',
    messages: {
      ru: { greet: { hello: 'Привет, {name}' } },
      en: { greet: { hello: 'Hello, {name}' } },
    },
  })

  expect(screen.getByText('Привет, Аня')).toBeInTheDocument()
  expect(screen.getByText('ru')).toBeInTheDocument()
  expect(screen.getByText('missing')).toBeInTheDocument()

  fireEvent.click(screen.getByRole('button', { name: 'switch' }))

  expect(screen.getByText('Hello, Аня')).toBeInTheDocument()
  expect(screen.getByText('en')).toBeInTheDocument()
})

test('returns the key when a translation is missing', () => {
  const t = {
    missing: undefined,
  }
  expect(t.missing).toBeUndefined()

  render(
    <LocaleProbe />,
    {
      // no provider: the runtime falls back to built-in UI messages
    },
  )

  expect(screen.getByText('greet.hello')).toBeInTheDocument()
})
