import { NodeViewWrapper, type NodeViewProps } from '@tiptap/react'

import { MentionPill } from '#/components/chat/mention-pill'
import { useMessageFormatContext } from '#/lib/message-format/message-format-context'

export function ChannelMentionNodeView({ node }: NodeViewProps) {
  const context = useMessageFormatContext()
  const channelId = node.attrs.id as string
  const channel = context.channels?.[channelId]
  const channelName =
    channel && 'name' in channel && channel.name ? channel.name : channelId

  return (
    <NodeViewWrapper as="span" className="inline">
      <MentionPill label={`#${channelName}`} />
    </NodeViewWrapper>
  )
}
