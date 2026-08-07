import { NodeViewWrapper, type NodeViewProps } from '@tiptap/react'

import { MentionPill } from '#/components/chat/mention-pill'
import { useMessageFormatContext } from '#/lib/message-format/message-format-context'
import { readStringNodeAttribute } from '#/lib/message-format/node-attrs'

export function RoleMentionNodeView({ node }: NodeViewProps) {
  const context = useMessageFormatContext()
  const roleId = readStringNodeAttribute(node.attrs, 'id') ?? ''
  const role = context.roles?.[roleId]
  const label = role?.name ?? roleId

  return (
    <NodeViewWrapper as="span" className="inline">
      <MentionPill label={`@${label}`} />
    </NodeViewWrapper>
  )
}
