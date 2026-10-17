// @vitest-environment jsdom

import { fireEvent, render, screen } from '@testing-library/react'
import { expect, test, vi } from 'vitest'

import { Button } from './index'

test('renders a button and forwards clicks', () => {
  const onClick = vi.fn()
  render(
    <Button variant="destructive" onClick={onClick}>
      Удалить
    </Button>,
  )

  fireEvent.click(screen.getByRole('button', { name: 'Удалить' }))
  expect(onClick).toHaveBeenCalledOnce()
})

test('asChild renders the child element with button props', () => {
  render(
    <Button asChild>
      <a href="/settings">Настройки</a>
    </Button>,
  )

  const link = screen.getByRole('link', { name: 'Настройки' })
  expect(link).toHaveAttribute('data-slot', 'button')
  expect(link).toHaveAttribute('href', '/settings')
})
