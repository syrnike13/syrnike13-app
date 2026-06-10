import { Node, mergeAttributes } from '@tiptap/core'
import { ReactNodeViewRenderer } from '@tiptap/react'

import { MassMentionNodeView } from '#/lib/message-format/node-views/mass-mention-node'

export const MassMentionNode = Node.create({
  name: 'massMention',
  group: 'inline',
  inline: true,
  atom: true,
  selectable: true,

  addAttributes() {
    return {
      kind: { default: 'everyone' },
    }
  },

  parseHTML() {
    return [{ tag: 'span[data-mass-mention]' }]
  },

  renderHTML({ HTMLAttributes }) {
    return [
      'span',
      mergeAttributes(HTMLAttributes, { 'data-mass-mention': '' }),
      0,
    ]
  },

  addNodeView() {
    return ReactNodeViewRenderer(MassMentionNodeView)
  },
})
