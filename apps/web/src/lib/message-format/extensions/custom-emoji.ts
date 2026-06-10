import { Node, mergeAttributes } from '@tiptap/core'
import { ReactNodeViewRenderer } from '@tiptap/react'

import { CustomEmojiNodeView } from '#/lib/message-format/node-views/custom-emoji-node'

export const CustomEmojiNode = Node.create({
  name: 'customEmoji',
  group: 'inline',
  inline: true,
  atom: true,
  selectable: true,

  addAttributes() {
    return {
      id: { default: null },
    }
  },

  parseHTML() {
    return [{ tag: 'span[data-custom-emoji]' }]
  },

  renderHTML({ HTMLAttributes }) {
    return [
      'span',
      mergeAttributes(HTMLAttributes, { 'data-custom-emoji': '' }),
      0,
    ]
  },

  addNodeView() {
    return ReactNodeViewRenderer(CustomEmojiNodeView)
  },
})
