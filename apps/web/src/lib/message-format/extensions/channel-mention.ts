import { Node, mergeAttributes } from '@tiptap/core'
import { ReactNodeViewRenderer } from '@tiptap/react'

import { ChannelMentionNodeView } from '#/lib/message-format/node-views/channel-mention-node'

export const ChannelMentionNode = Node.create({
  name: 'channelMention',
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
    return [{ tag: 'span[data-channel-mention]' }]
  },

  renderHTML({ node, HTMLAttributes }) {
    return [
      'span',
      mergeAttributes(HTMLAttributes, { 'data-channel-mention': '' }),
      `<#${node.attrs.id ?? ''}>`,
    ]
  },

  renderText({ node }) {
    return `<#${node.attrs.id ?? ''}>`
  },

  addNodeView() {
    return ReactNodeViewRenderer(ChannelMentionNodeView)
  },
})
