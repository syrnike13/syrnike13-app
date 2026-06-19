// @vitest-environment jsdom

import { cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { ComposerEditor } from '#/components/chat/composer-editor'

describe('ComposerEditor', () => {
  afterEach(() => {
    cleanup()
    vi.clearAllMocks()
  })

  it('forwards Escape key presses to the parent composer', async () => {
    const onKeyDown = vi.fn()
    const { container } = render(
      <ComposerEditor
        value=""
        formatContext={{}}
        mentionItems={() => []}
        onValueChange={vi.fn()}
        onKeyDown={onKeyDown}
      />,
    )

    const editor = await waitFor(() => {
      const element = container.querySelector('.tiptap')
      expect(element).toBeTruthy()
      return element as HTMLElement
    })

    fireEvent.keyDown(editor, { key: 'Escape' })

    expect(onKeyDown).toHaveBeenCalledWith(
      expect.objectContaining({ key: 'Escape' }),
    )
  })
})
