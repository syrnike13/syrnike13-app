// @vitest-environment jsdom

import { Editor } from '@tiptap/core'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { createMessageExtensions } from '#/lib/message-format/extensions'

describe('createMessageExtensions', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('does not register duplicate Tiptap extension names', () => {
    const consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const editor = new Editor({
      element: document.createElement('div'),
      extensions: createMessageExtensions(),
      content: '',
    })

    editor.destroy()

    expect(consoleWarn).not.toHaveBeenCalledWith(
      expect.stringContaining('Duplicate extension names'),
    )
  })
})
