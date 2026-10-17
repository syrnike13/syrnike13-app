// @vitest-environment jsdom

import { cleanup, render } from '@testing-library/react'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@syrnike13/ui/primitives/tooltip'

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

  it('renders the shadcn tooltip content without an arrow', () => {
    render(
      <TooltipProvider>
        <Tooltip open>
          <TooltipTrigger>Триггер</TooltipTrigger>
          <TooltipContent>Подсказка</TooltipContent>
        </Tooltip>
      </TooltipProvider>,
    )

    const content = document.querySelector('[data-slot="tooltip-content"]')
    expect(content).toBeInTheDocument()
    expect(content).toHaveTextContent('Подсказка')
    expect(content?.querySelector('svg')).toBeNull()
  })
})
