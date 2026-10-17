// @vitest-environment jsdom

import { fireEvent, render, screen } from '@testing-library/react'
import { expect, test } from 'vitest'

import { Button } from '../button'
import { Sheet, SheetContent, SheetTitle, SheetTrigger } from './index'

test('opens a sheet from its trigger', async () => {
  render(
    <Sheet>
      <SheetTrigger render={<Button />}>Открыть</SheetTrigger>
      <SheetContent>
        <SheetTitle>Панель</SheetTitle>
        Содержимое панели
      </SheetContent>
    </Sheet>,
  )

  fireEvent.click(screen.getByRole('button', { name: 'Открыть' }))

  expect(await screen.findByText('Содержимое панели')).toBeInTheDocument()
  expect(screen.getByRole('dialog')).toHaveAttribute('data-slot', 'sheet-content')
})
