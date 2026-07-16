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

  it('keeps inline mention tokens in clipboard text and HTML', () => {
    const editor = new Editor({
      element: document.createElement('div'),
      extensions: createMessageExtensions(),
      content: {
        type: 'doc',
        content: [
          {
            type: 'paragraph',
            content: [
              { type: 'userMention', attrs: { id: 'user-id' } },
              { type: 'text', text: ' ' },
              { type: 'massMention', attrs: { kind: 'online' } },
              { type: 'text', text: ' ' },
              { type: 'roleMention', attrs: { id: 'role-id' } },
              { type: 'text', text: ' ' },
              { type: 'channelMention', attrs: { id: 'channel-id' } },
            ],
          },
        ],
      },
    })

    expect(editor.getText()).toBe(
      '<@user-id> @online <%role-id> <#channel-id>',
    )
    expect(editor.getHTML()).toContain('data-user-mention')
    expect(editor.getHTML()).toContain('&lt;@user-id&gt;')
    editor.destroy()
  })
})
