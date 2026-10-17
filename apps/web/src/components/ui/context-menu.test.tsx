// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from '@syrnike13/ui/primitives/context-menu'

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

describe('ContextMenuContent', () => {
  afterEach(() => {
    cleanup()
  })

  it('renders the shadcn context menu content slot', async () => {
    render(
      <ContextMenu>
        <ContextMenuTrigger>Триггер</ContextMenuTrigger>
        <ContextMenuContent>
          <ContextMenuItem>Действие</ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>,
    )

    fireEvent.contextMenu(
      document.querySelector('[data-slot="context-menu-trigger"]')!,
    )

    expect(await screen.findByText('Действие')).toBeInTheDocument()
    expect(
      document.querySelector('[data-slot="context-menu-content"]'),
    ).toBeInTheDocument()
  })
})
