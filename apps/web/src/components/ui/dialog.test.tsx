// @vitest-environment jsdom

import { cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'

import {
  Dialog,
  DialogContent,
  DialogTitle,
} from '@syrnike13/ui/primitives/dialog'

describe('DialogContent', () => {
  afterEach(() => {
    cleanup()
  })

  it('renders the shadcn dialog content slot', () => {
    render(
      <Dialog open>
        <DialogContent>
          <DialogTitle>Тестовое окно</DialogTitle>
        </DialogContent>
      </Dialog>,
    )

    expect(
      document.querySelector('[data-slot="dialog-content"]'),
    ).toBeInTheDocument()
  })
})
