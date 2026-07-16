// @vitest-environment jsdom

import { cleanup, render } from '@testing-library/react'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '#/components/ui/tooltip'

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

describe('TooltipContent', () => {
  afterEach(() => {
    cleanup()
  })

  it('uses the solid themed surface without an arrow', () => {
    render(
      <TooltipProvider>
        <Tooltip open>
          <TooltipTrigger>Триггер</TooltipTrigger>
          <TooltipContent>Подсказка</TooltipContent>
        </Tooltip>
      </TooltipProvider>,
    )

    const content = document.querySelector('[data-slot="tooltip-content"]')
    expect(content?.classList.contains('gradient-surface-solid')).toBe(true)
    expect(content?.classList.contains('gradient-surface-floating')).toBe(false)
    expect(content?.querySelector('svg')).toBeNull()
  })
})
