// @vitest-environment jsdom

import { render, screen } from '@testing-library/react'
import { beforeAll, expect, it, vi } from 'vitest'

import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@syrnike13/ui/primitives/popover'

import { StreamSettingsSubmenu } from './voice-screen-share-quality'

beforeAll(() => {
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  )
})

it('does not open the nested settings popover when its trigger receives focus', async () => {
  render(
    <Popover defaultOpen>
      <PopoverTrigger>Открыть</PopoverTrigger>
      <PopoverContent>
        <StreamSettingsSubmenu label="Качество">
          <div>Вложенный список</div>
        </StreamSettingsSubmenu>
      </PopoverContent>
    </Popover>,
  )

  const trigger = await screen.findByRole('button', { name: /Качество/ })
  trigger.focus()

  expect(screen.queryByText('Вложенный список')).toBeNull()
})
