import {
  forwardRef,
  useEffect,
  useId,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type RefObject,
} from 'react'
import Placeholder from '@tiptap/extension-placeholder'
import { TextSelection } from '@tiptap/pm/state'
import { EditorContent, useEditor } from '@tiptap/react'
import type { SuggestionProps } from '@tiptap/suggestion'

import {
  MentionSuggestionMenu,
  type MentionSuggestionState,
} from '#/components/chat/mention-suggestion-menu'
import { deserializeMessageContent } from '#/lib/message-format/deserialize'
import { createMessageExtensions } from '#/lib/message-format/extensions'
import type { MentionSuggestionItem } from '#/lib/message-format/extensions/mention-suggestion'
import { MessageFormatProvider } from '#/lib/message-format/message-format-context'
import { serializeMessageContent } from '#/lib/message-format/serialize'
import type { MessageFormatContext } from '#/lib/message-format/types'
import { cn } from '#/lib/utils'

export type ComposerEditorHandle = {
  focus: () => void
  insertText: (text: string) => void
  insertCustomEmoji: (emojiId: string) => void
  clear: () => void
}

type ComposerEditorProps = {
  value: string
  placeholder?: string
  disabled?: boolean
  className?: string
  editorClassName?: string
  formatContext: MessageFormatContext
  mentionItems: (query: string) => MentionSuggestionItem[]
  channelItems?: (query: string) => MentionSuggestionItem[]
  onValueChange: (value: string) => void
  onPasteFiles?: (files: FileList) => void
  onKeyDown?: (event: ReactKeyboardEvent) => void
  /** Якорь для меню @-упоминаний (обычно вся строка ввода). */
  menuAnchorRef?: RefObject<HTMLElement | null>
  menuSurfaceClassName?: string
}

export const ComposerEditor = forwardRef<ComposerEditorHandle, ComposerEditorProps>(
  function ComposerEditor(
    {
      value,
      placeholder,
      disabled,
      className,
      editorClassName,
      formatContext,
      mentionItems,
      channelItems,
      onValueChange,
      onPasteFiles,
      onKeyDown,
      menuAnchorRef,
      menuSurfaceClassName,
    },
    ref,
  ) {
    const editorRootRef = useRef<HTMLDivElement>(null)
    const mentionMenuId = `composer-mentions-${useId().replaceAll(':', '')}`
    const mentionMenuAnchorRef = menuAnchorRef ?? editorRootRef
    const lastEmittedRef = useRef(value)
    const editorClassNameRef = useRef(editorClassName)
    const mentionItemsRef = useRef(mentionItems)
    const channelItemsRef = useRef(channelItems)
    const onPasteFilesRef = useRef(onPasteFiles)
    const onValueChangeRef = useRef(onValueChange)
    const placeholderRef = useRef(placeholder)
    const valueRef = useRef(value)
    mentionItemsRef.current = mentionItems
    channelItemsRef.current = channelItems
    editorClassNameRef.current = editorClassName
    onPasteFilesRef.current = onPasteFiles
    onValueChangeRef.current = onValueChange
    placeholderRef.current = placeholder
    valueRef.current = value

    const [mentionSuggestion, setMentionSuggestion] =
      useState<MentionSuggestionState | null>(null)
    const mentionSuggestionRef = useRef<MentionSuggestionState | null>(null)
    const selectedIndexRef = useRef(0)
    const onKeyDownRef = useRef(onKeyDown)

    onKeyDownRef.current = onKeyDown

    const closeMentionSuggestion = () => {
      mentionSuggestionRef.current = null
      selectedIndexRef.current = 0
      setMentionSuggestion(null)
    }

    const syncMentionSuggestion = (
      props: SuggestionProps<MentionSuggestionItem>,
      selectedIndex = 0,
    ) => {
      selectedIndexRef.current = selectedIndex
      const next: MentionSuggestionState = {
        ...props,
        selectedIndex,
        onHighlightIndex: (index: number) => {
          selectedIndexRef.current = index
          const current = mentionSuggestionRef.current
          if (!current) return
          const updated = { ...current, selectedIndex: index }
          mentionSuggestionRef.current = updated
          setMentionSuggestion(updated)
        },
      }
      mentionSuggestionRef.current = next
      setMentionSuggestion(next)
    }

    const handleMentionKeyDown = (event: KeyboardEvent) => {
      const props = mentionSuggestionRef.current
      if (!props?.items.length) return false

      if (
        event.key === 'Enter' &&
        (event.isComposing || event.keyCode === 229)
      ) {
        return false
      }

      if (event.key === 'ArrowDown') {
        event.preventDefault()
        const nextIndex = (selectedIndexRef.current + 1) % props.items.length
        syncMentionSuggestion(props, nextIndex)
        return true
      }

      if (event.key === 'ArrowUp') {
        event.preventDefault()
        const nextIndex =
          (selectedIndexRef.current - 1 + props.items.length) %
          props.items.length
        syncMentionSuggestion(props, nextIndex)
        return true
      }

      if (event.key === 'Enter' || event.key === 'Tab') {
        event.preventDefault()
        const item = props.items[selectedIndexRef.current]
        if (item) props.command(item)
        return true
      }

      if (event.key === 'Escape') {
        event.preventDefault()
        closeMentionSuggestion()
        return true
      }

      return false
    }

    const extensions = useMemo(
      () =>
        [
          ...createMessageExtensions({
            mentionSuggestion: {
              items: ({ query }) => mentionItemsRef.current(query),
              render: () => ({
                onStart: (props) => syncMentionSuggestion(props, 0),
                onUpdate: (props) => syncMentionSuggestion(props, 0),
                onExit: closeMentionSuggestion,
                onKeyDown: ({ event }) => handleMentionKeyDown(event),
              }),
            },
            channelSuggestion: {
              name: 'channelSuggestion',
              char: '#',
              items: ({ query }) => channelItemsRef.current?.(query) ?? [],
              render: () => ({
                onStart: (props) => syncMentionSuggestion(props, 0),
                onUpdate: (props) => syncMentionSuggestion(props, 0),
                onExit: closeMentionSuggestion,
                onKeyDown: ({ event }) => handleMentionKeyDown(event),
              }),
            },
          }),
          Placeholder.configure({
            placeholder: () => placeholderRef.current ?? '',
            emptyEditorClass: 'is-editor-empty',
            showOnlyWhenEditable: false,
          }),
        ],
      [],
    )

    const editor = useEditor({
      immediatelyRender: false,
      extensions,
      editable: !disabled,
      content: deserializeMessageContent(value),
      editorProps: {
        attributes: () => {
          const activeMention = mentionSuggestionRef.current

          return {
            class: cn(
              'tiptap max-h-40 min-h-9 w-full overflow-y-auto px-2 py-2 text-base leading-6 break-words outline-none md:text-sm',
              editorClassNameRef.current,
            ),
            role: 'textbox',
            'aria-label': 'Сообщение',
            'aria-multiline': 'true',
            'aria-autocomplete': 'list',
            ...(activeMention?.items.length
              ? {
                  'aria-controls': mentionMenuId,
                  'aria-activedescendant': `${mentionMenuId}-option-${activeMention.selectedIndex}`,
                }
              : {}),
          }
        },
        handleKeyDown: (view, event) => {
          if (mentionSuggestionRef.current) {
            if (handleMentionKeyDown(event)) {
              return true
            }
          }

          const isSelectAll =
            (event.code === 'KeyA' || event.key.toLowerCase() === 'a') &&
            (event.ctrlKey || event.metaKey)
          const onlyBlock = view.state.doc.firstChild
          const isEmptyDocument =
            view.state.doc.childCount === 1 &&
            onlyBlock?.isTextblock === true &&
            onlyBlock.content.size === 0

          if (isSelectAll && isEmptyDocument) {
            event.preventDefault()
            view.dispatch(
              view.state.tr.setSelection(TextSelection.atStart(view.state.doc)),
            )
            return true
          }

          if (event.key === 'Escape' && onKeyDownRef.current) {
            event.preventDefault()
            onKeyDownRef.current(event as unknown as ReactKeyboardEvent)
            return true
          }

          if (
            event.key === 'Enter' &&
            !event.shiftKey &&
            !event.isComposing &&
            event.keyCode !== 229
          ) {
            event.preventDefault()
            onKeyDownRef.current?.(event as unknown as ReactKeyboardEvent)
            return true
          }
          return false
        },
        handlePaste: (_view, event) => {
          const files = event.clipboardData?.files
          const pasteFiles = onPasteFilesRef.current
          if (files && files.length > 0 && pasteFiles) {
            event.preventDefault()
            pasteFiles(files)
            return true
          }
          return false
        },
      },
      onUpdate: ({ editor: currentEditor }) => {
        if (currentEditor.isEmpty && !currentEditor.state.selection.empty) {
          currentEditor.commands.setTextSelection(1)
        }

        const wire = serializeMessageContent(currentEditor.getJSON())
        if (valueRef.current !== lastEmittedRef.current) return
        lastEmittedRef.current = wire
        onValueChangeRef.current(wire)
      },
    }, [])

    useEffect(() => {
      if (!editor) return
      editor.setEditable(!disabled)
    }, [disabled, editor])

    useEffect(() => {
      if (!editor) return
      editor.view.dispatch(editor.state.tr)
    }, [editor, editorClassName, mentionSuggestion, placeholder])

    useEffect(() => {
      if (!editor || value === lastEmittedRef.current) return

      lastEmittedRef.current = value

      if (!value) {
        editor.commands.clearContent(false)
        return
      }

      editor.commands.setContent(deserializeMessageContent(value), {
        emitUpdate: false,
      })
    }, [editor, value])

    useImperativeHandle(ref, () => ({
      focus() {
        editor?.commands.focus('end')
      },
      insertText(text: string) {
        editor?.chain().focus().insertContent(text).run()
      },
      insertCustomEmoji(emojiId: string) {
        editor
          ?.chain()
          .focus()
          .insertContent({ type: 'customEmoji', attrs: { id: emojiId } })
          .run()
      },
      clear() {
        lastEmittedRef.current = ''
        editor?.commands.clearContent(false)
      },
    }))

    return (
      <MessageFormatProvider value={formatContext}>
        <div
          ref={editorRootRef}
          className={cn('relative min-h-9 min-w-0 flex-1', className)}
        >
          {mentionSuggestion ? (
            <MentionSuggestionMenu
              id={mentionMenuId}
              suggestion={mentionSuggestion}
              anchorRef={mentionMenuAnchorRef}
              surfaceClassName={menuSurfaceClassName}
            />
          ) : null}
          <EditorContent editor={editor} />
        </div>
      </MessageFormatProvider>
    )
  },
)
