// @vitest-environment jsdom

import { fireEvent, render, screen } from '@testing-library/react'
import { expect, test } from 'vitest'

import { Checkbox } from './index'

test('toggles between checked and unchecked', () => {
  render(<Checkbox aria-label="Согласие" />)

  const checkbox = screen.getByRole('checkbox', { name: 'Согласие' })
  expect(checkbox).not.toBeChecked()

  fireEvent.click(checkbox)
  expect(checkbox).toBeChecked()

  fireEvent.click(checkbox)
  expect(checkbox).not.toBeChecked()
})
