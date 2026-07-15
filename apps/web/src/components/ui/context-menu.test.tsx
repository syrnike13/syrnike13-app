// @vitest-environment jsdom

import { cleanup, fireEvent, render } from '@testing-library/react'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from '#/components/ui/context-menu'

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

  it('uses the solid themed surface on the root content', () => {
    render(
      <ContextMenu>
        <ContextMenuTrigger>Триггер</ContextMenuTrigger>
        <ContextMenuContent>
          <ContextMenuItem>Действие</ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>,
    )

    fireEvent.contextMenu(document.querySelector('[data-slot="context-menu-trigger"]')!)

    const content = document.querySelector('[data-slot="context-menu-content"]')
    expect(content?.classList.contains('gradient-surface-solid')).toBe(true)
    expect(content?.classList.contains('gradient-surface-floating')).toBe(false)
  })
})
