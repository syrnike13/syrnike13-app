import { Node, mergeAttributes } from '@tiptap/core'
import { ReactNodeViewRenderer } from '@tiptap/react'

import { RoleMentionNodeView } from '#/lib/message-format/node-views/role-mention-node'

export const RoleMentionNode = Node.create({
  name: 'roleMention',
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
    return [{ tag: 'span[data-role-mention]' }]
  },

  renderHTML({ node, HTMLAttributes }) {
    return [
      'span',
      mergeAttributes(HTMLAttributes, { 'data-role-mention': '' }),
      `<%${node.attrs.id ?? ''}>`,
    ]
  },

  renderText({ node }) {
    return `<%${node.attrs.id ?? ''}>`
  },

  addNodeView() {
    return ReactNodeViewRenderer(RoleMentionNodeView)
  },
})
