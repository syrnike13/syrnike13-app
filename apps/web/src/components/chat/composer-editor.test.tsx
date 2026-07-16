// @vitest-environment jsdom

import { createRef } from 'react'
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

import { ComposerEditor } from '#/components/chat/composer-editor'
import {
  MentionSuggestionMenu,
  type MentionSuggestionState,
} from '#/components/chat/mention-suggestion-menu'

beforeAll(() => {
  Element.prototype.scrollIntoView = vi.fn()
  document.elementFromPoint = vi.fn(() => null)
  Range.prototype.getClientRects = vi.fn(() => [] as unknown as DOMRectList)
  Range.prototype.getBoundingClientRect = vi.fn(() => new DOMRect())
})

afterEach(() => {
  cleanup()
})

function renderEditor(onKeyDown = vi.fn()) {
  const editorRef = createRef<React.ComponentRef<typeof ComposerEditor>>()
  const result = render(
    <ComposerEditor
      ref={editorRef}
      value=""
      placeholder="Написать сообщение"
      formatContext={{}}
      mentionItems={() => [
        {
          kind: 'everyone',
          label: '@everyone',
          description: 'Все участники',
        },
      ]}
      onValueChange={vi.fn()}
      onKeyDown={onKeyDown}
    />,
  )

  return { ...result, editorRef, onKeyDown }
}

describe('ComposerEditor keyboard behavior', () => {
  it('submits on Enter, but leaves Shift+Enter to TipTap', async () => {
    const { onKeyDown } = renderEditor()
    const textbox = await screen.findByRole('textbox', { name: 'Сообщение' })

    fireEvent.keyDown(textbox, { key: 'Enter' })
    fireEvent.keyDown(textbox, { key: 'Enter', shiftKey: true })

    expect(onKeyDown).toHaveBeenCalledTimes(1)
    expect(onKeyDown.mock.calls[0]?.[0].key).toBe('Enter')
  })

  it('does not submit while an IME composition is active', async () => {
    const { onKeyDown } = renderEditor()
    const textbox = await screen.findByRole('textbox', { name: 'Сообщение' })

    fireEvent.keyDown(textbox, { key: 'Enter', isComposing: true })
    fireEvent.keyDown(textbox, { key: 'Enter', keyCode: 229 })

    expect(onKeyDown).not.toHaveBeenCalled()
  })

  it('forwards Escape when no mention menu is open', async () => {
    const { onKeyDown } = renderEditor()
    const textbox = await screen.findByRole('textbox', { name: 'Сообщение' })

    fireEvent.keyDown(textbox, { key: 'Escape' })

    expect(onKeyDown).toHaveBeenCalledTimes(1)
    expect(onKeyDown.mock.calls[0]?.[0].key).toBe('Escape')
  })

  it.each([
    { key: 'a', code: 'KeyA', label: 'Latin layout' },
    { key: 'ф', code: 'KeyA', label: 'Russian layout' },
  ])('keeps Ctrl+A as a caret when the editor is empty ($label)', async ({
    key,
    code,
  }) => {
    const { onKeyDown } = renderEditor()
    const textbox = await screen.findByRole('textbox', { name: 'Сообщение' })

    const allowedNativeSelection = fireEvent.keyDown(textbox, {
      key,
      code,
      ctrlKey: true,
    })

    expect(allowedNativeSelection).toBe(false)
    expect(onKeyDown).not.toHaveBeenCalled()
  })

  it('collapses the selection after deleting all editor content', async () => {
    const { editorRef } = renderEditor()
    const textbox = await screen.findByRole('textbox', { name: 'Сообщение' })

    act(() => {
      editorRef.current?.insertText('test')
    })
    await waitFor(() => expect(textbox.textContent).toBe('test'))

    const range = document.createRange()
    range.selectNodeContents(textbox)
    const selection = window.getSelection()
    selection?.removeAllRanges()
    selection?.addRange(range)
    act(() => {
      editorRef.current?.clear()
    })

    await waitFor(() => {
      expect(textbox.textContent).toBe('')
      expect(window.getSelection()?.isCollapsed).toBe(true)
    })
  })

  it('closes an open mention menu before forwarding a later Escape', async () => {
    const { onKeyDown } = renderEditor()
    const textbox = await screen.findByRole('textbox', { name: 'Сообщение' })

    textbox.focus()
    textbox.innerHTML = '<p>@</p>'
    const range = document.createRange()
    range.selectNodeContents(textbox)
    range.collapse(false)
    const selection = window.getSelection()
    selection?.removeAllRanges()
    selection?.addRange(range)
    fireEvent.input(textbox, { data: '@', inputType: 'insertText' })

    await screen.findByRole('listbox', { name: 'Упоминания' })
    expect(textbox.getAttribute('aria-activedescendant')).toMatch(
      /-option-0$/,
    )

    fireEvent.keyDown(textbox, { key: 'Escape' })
    expect(screen.queryByRole('listbox', { name: 'Упоминания' })).toBeNull()
    expect(textbox.hasAttribute('aria-activedescendant')).toBe(false)
    expect(onKeyDown).not.toHaveBeenCalled()

    fireEvent.keyDown(textbox, { key: 'Escape' })
    expect(onKeyDown).toHaveBeenCalledTimes(1)
  })

  it('keeps the editor instance and updates its placeholder after rerender', async () => {
    const { rerender } = renderEditor()
    const textbox = await screen.findByRole('textbox', { name: 'Сообщение' })

    rerender(
      <ComposerEditor
        value=""
        placeholder="Изменённый placeholder"
        formatContext={{}}
        mentionItems={() => []}
        onValueChange={vi.fn()}
      />,
    )

    expect(screen.getByRole('textbox', { name: 'Сообщение' })).toBe(textbox)
    await waitFor(() => {
      expect(textbox.querySelector('p')?.dataset.placeholder).toBe(
        'Изменённый placeholder',
      )
    })
  })
})

describe('MentionSuggestionMenu accessibility', () => {
  it('exposes a listbox with stable option ids and selection state', async () => {
    const anchor = document.createElement('div')
    document.body.append(anchor)
    const anchorRef = createRef<HTMLDivElement>()
    anchorRef.current = anchor
    vi.spyOn(anchor, 'getBoundingClientRect').mockReturnValue({
      bottom: 140,
      height: 40,
      left: 20,
      right: 320,
      top: 100,
      width: 300,
      x: 20,
      y: 100,
      toJSON: () => ({}),
    })

    const suggestion = {
      items: [
        {
          kind: 'everyone',
          label: '@everyone',
          description: 'Все участники',
        },
        {
          kind: 'online',
          label: '@online',
          description: 'Участники онлайн',
        },
      ],
      selectedIndex: 1,
      command: vi.fn(),
    } as unknown as MentionSuggestionState

    await act(async () => {
      render(
        <MentionSuggestionMenu
          id="composer-mentions-test"
          suggestion={suggestion}
          anchorRef={anchorRef}
        />,
      )
    })

    const listbox = await screen.findByRole('listbox', { name: 'Упоминания' })
    const options = screen.getAllByRole('option')

    expect(listbox.id).toBe('composer-mentions-test')
    expect(options.map((option) => option.id)).toEqual([
      'composer-mentions-test-option-0',
      'composer-mentions-test-option-1',
    ])
    expect(options[0]?.getAttribute('aria-selected')).toBe('false')
    expect(options[1]?.getAttribute('aria-selected')).toBe('true')

    anchor.remove()
  })
})
