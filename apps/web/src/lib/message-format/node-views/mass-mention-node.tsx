import { NodeViewWrapper, type NodeViewProps } from '@tiptap/react'

import { MentionPill } from '#/components/chat/mention-pill'
import { readStringNodeAttribute } from '#/lib/message-format/node-attrs'

export function MassMentionNodeView({ node }: NodeViewProps) {
  const kind = readStringNodeAttribute(node.attrs, 'kind')
  const label = kind === 'online' ? '@online' : '@everyone'

  return (
    <NodeViewWrapper as="span" className="inline">
      <MentionPill label={label} />
    </NodeViewWrapper>
  )
}
