// @vitest-environment jsdom

import { fireEvent, render, screen } from '@testing-library/react'
import { expect, test } from 'vitest'

import { Button } from '../button'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogTitle,
  AlertDialogTrigger,
} from './index'

test('opens the confirmation dialog and exposes both actions', async () => {
  render(
    <AlertDialog>
      <AlertDialogTrigger asChild>
        <Button>Удалить</Button>
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogTitle>Удалить канал?</AlertDialogTitle>
        <AlertDialogDescription>Действие необратимо.</AlertDialogDescription>
        <AlertDialogFooter>
          <AlertDialogCancel>Отмена</AlertDialogCancel>
          <AlertDialogAction>Удалить</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>,
  )

  fireEvent.click(screen.getByRole('button', { name: 'Удалить' }))

  expect(await screen.findByText('Удалить канал?')).toBeInTheDocument()
  expect(screen.getByRole('button', { name: 'Отмена' })).toBeInTheDocument()
  expect(screen.getByRole('button', { name: 'Удалить' })).toBeInTheDocument()
})
