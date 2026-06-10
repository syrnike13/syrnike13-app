import { Node, mergeAttributes } from '@tiptap/core'
import { ReactNodeViewRenderer } from '@tiptap/react'

import { UserMentionNodeView } from '#/lib/message-format/node-views/user-mention-node'

export const UserMentionNode = Node.create({
  name: 'userMention',
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
    return [{ tag: 'span[data-user-mention]' }]
  },

  renderHTML({ HTMLAttributes }) {
    return [
      'span',
      mergeAttributes(HTMLAttributes, { 'data-user-mention': '' }),
      0,
    ]
  },

  addNodeView() {
    return ReactNodeViewRenderer(UserMentionNodeView)
  },
})
