// @vitest-environment jsdom

import { fireEvent, render, screen } from '@testing-library/react'
import { expect, test } from 'vitest'

import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from './index'

test('filters items by the command input', () => {
  render(
    <Command>
      <CommandInput placeholder="Поиск" />
      <CommandList>
        <CommandEmpty>Ничего не найдено</CommandEmpty>
        <CommandGroup>
          <CommandItem value="Сырники">Сырники</CommandItem>
          <CommandItem value="Блины">Блины</CommandItem>
        </CommandGroup>
      </CommandList>
    </Command>,
  )

  fireEvent.change(screen.getByPlaceholderText('Поиск'), {
    target: { value: 'сыр' },
  })

  expect(screen.getByText('Сырники')).toBeInTheDocument()
  expect(screen.queryByText('Блины')).not.toBeInTheDocument()
})

test('shows the empty state when nothing matches', () => {
  render(
    <Command>
      <CommandInput placeholder="Поиск" />
      <CommandList>
        <CommandEmpty>Ничего не найдено</CommandEmpty>
        <CommandGroup>
          <CommandItem value="Сырники">Сырники</CommandItem>
        </CommandGroup>
      </CommandList>
    </Command>,
  )

  fireEvent.change(screen.getByPlaceholderText('Поиск'), {
    target: { value: 'xyz' },
  })

  expect(screen.getByText('Ничего не найдено')).toBeInTheDocument()
})
