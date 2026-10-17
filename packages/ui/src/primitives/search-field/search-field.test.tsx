// @vitest-environment jsdom

import { fireEvent, render, screen } from '@testing-library/react'
import { expect, test, vi } from 'vitest'

import { SearchField } from './index'

test('shows a clear button for a non-empty value and calls onClear', () => {
  const onClear = vi.fn()
  render(
    <SearchField
      value="сырники"
      onClear={onClear}
      clearLabel="Очистить поиск"
      placeholder="Поиск"
    />,
  )

  expect(screen.getByPlaceholderText('Поиск')).toHaveValue('сырники')
  fireEvent.click(screen.getByRole('button', { name: 'Очистить поиск' }))
  expect(onClear).toHaveBeenCalledOnce()
})

test('hides the clear button for an empty value', () => {
  render(<SearchField value="" onClear={() => {}} />)
  expect(screen.queryByRole('button')).not.toBeInTheDocument()
})
