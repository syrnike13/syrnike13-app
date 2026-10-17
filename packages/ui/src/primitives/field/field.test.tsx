// @vitest-environment jsdom

import { render, screen } from '@testing-library/react'
import { expect, test } from 'vitest'

import { Field } from './index'
import { Input } from '../input'

test('links the label to the control and shows a hint', () => {
  render(
    <Field label="Имя" hint="Как к вам обращаться">
      <Input />
    </Field>,
  )

  expect(screen.getByLabelText('Имя')).toBeInTheDocument()
  expect(screen.getByText('Как к вам обращаться')).toBeInTheDocument()
})

test('shows an error instead of the hint', () => {
  render(
    <Field label="Имя" hint="Подсказка" error="Обязательное поле">
      <Input />
    </Field>,
  )

  expect(screen.getByRole('alert')).toHaveTextContent('Обязательное поле')
  expect(screen.queryByText('Подсказка')).not.toBeInTheDocument()
})
