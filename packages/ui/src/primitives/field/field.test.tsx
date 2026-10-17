// @vitest-environment jsdom

import { render, screen } from '@testing-library/react'
import { expect, test } from 'vitest'

import { Field, FieldDescription, FieldError, FieldLabel } from './index'
import { Input } from '../input'

test('links the label to the control and shows a description', () => {
  render(
    <Field>
      <FieldLabel htmlFor="field-name">Имя</FieldLabel>
      <Input id="field-name" />
      <FieldDescription>Как к вам обращаться</FieldDescription>
    </Field>,
  )

  expect(screen.getByLabelText('Имя')).toBeInTheDocument()
  expect(screen.getByText('Как к вам обращаться')).toBeInTheDocument()
})

test('shows field errors', () => {
  render(
    <Field data-invalid="true">
      <FieldLabel htmlFor="field-error-name">Имя</FieldLabel>
      <Input id="field-error-name" aria-invalid />
      <FieldError>Обязательное поле</FieldError>
    </Field>,
  )

  expect(screen.getByRole('alert')).toHaveTextContent('Обязательное поле')
})
