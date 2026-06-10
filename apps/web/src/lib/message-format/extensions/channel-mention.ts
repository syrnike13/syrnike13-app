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

  renderHTML({ HTMLAttributes }) {
    return [
      'span',
      mergeAttributes(HTMLAttributes, { 'data-channel-mention': '' }),
      0,
    ]
  },

  addNodeView() {
    return ReactNodeViewRenderer(ChannelMentionNodeView)
  },
})
