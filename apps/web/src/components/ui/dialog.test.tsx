// @vitest-environment jsdom

import { cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'

import {
  Dialog,
  DialogContent,
  DialogTitle,
} from '#/components/ui/dialog'

describe('DialogContent', () => {
  afterEach(() => {
    cleanup()
  })

  it('uses the solid themed surface by default', () => {
    render(
      <Dialog open>
        <DialogContent>
          <DialogTitle>Тестовое окно</DialogTitle>
        </DialogContent>
      </Dialog>,
    )

    expect(
      document
        .querySelector('[data-slot="dialog-content"]')
        ?.classList.contains('gradient-surface-solid'),
    ).toBe(true)
  })

  it('allows transparent lightboxes to opt out', () => {
    render(
      <Dialog open>
        <DialogContent themedSurface={false}>
          <DialogTitle>Просмотр изображения</DialogTitle>
        </DialogContent>
      </Dialog>,
    )

    expect(
      document
        .querySelector('[data-slot="dialog-content"]')
        ?.classList.contains('gradient-surface-solid'),
    ).toBe(false)
  })
})
