// @vitest-environment jsdom

import { createRef } from 'react'
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react'
import type { User } from '@syrnike13/api-types'
import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  ComposerEditor,
  type ComposerEditorHandle,
} from '#/components/chat/composer-editor'

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

  it('closes mention suggestions on Escape before forwarding cancel to the parent', async () => {
    const onKeyDown = vi.fn()
    const ref = createRef<ComposerEditorHandle>()
    const mentioned = {
      _id: 'user-1',
      username: 'isa',
      online: true,
    } as User
    const { container } = render(
      <ComposerEditor
        ref={ref}
        value=""
        formatContext={{}}
        mentionItems={() => [
          {
            kind: 'user',
            id: mentioned._id,
            user: mentioned,
            serverName: 'Isa',
            username: mentioned.username,
          },
        ]}
        onValueChange={vi.fn()}
        onKeyDown={onKeyDown}
      />,
    )

    const editor = await waitFor(() => {
      const element = container.querySelector('.tiptap')
      expect(element).toBeTruthy()
      return element as HTMLElement
    })

    ref.current?.insertText('@')

    await waitFor(() => {
      expect(screen.getByText('@isa')).toBeTruthy()
    })

    fireEvent.keyDown(editor, { key: 'Escape' })

    expect(onKeyDown).not.toHaveBeenCalled()
    await waitFor(() => {
      expect(screen.queryByText('@isa')).toBeNull()
    })
  })
})
