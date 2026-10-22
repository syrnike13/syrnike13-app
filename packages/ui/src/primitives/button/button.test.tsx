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

test('applies upstream shadcn variant classes', () => {
  render(<Button variant="outline">Настройки</Button>)

  const button = screen.getByRole('button', { name: 'Настройки' })
  expect(button).toHaveAttribute('data-slot', 'button')
  expect(button).toHaveClass('border-border')
  expect(button).toHaveClass('bg-background')
})
