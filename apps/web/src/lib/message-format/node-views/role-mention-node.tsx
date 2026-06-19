import { NodeViewWrapper, type NodeViewProps } from '@tiptap/react'

import { MentionPill } from '#/components/chat/mention-pill'
import { useMessageFormatContext } from '#/lib/message-format/message-format-context'

export function RoleMentionNodeView({ node }: NodeViewProps) {
  const context = useMessageFormatContext()
  const roleId = node.attrs.id as string
  const role = context.roles?.[roleId]
  const label = role?.name ?? roleId

  return (
    <NodeViewWrapper as="span" className="inline">
      <MentionPill label={`@${label}`} />
    </NodeViewWrapper>
  )
}
