import { NodeViewWrapper, type NodeViewProps } from '@tiptap/react'

import { MentionPill } from '#/components/chat/mention-pill'

export function MassMentionNodeView({ node }: NodeViewProps) {
  const kind = node.attrs.kind as string
  const label = kind === 'online' ? 'online' : 'everyone'

  return (
    <NodeViewWrapper as="span" className="inline">
      <MentionPill label={label} />
    </NodeViewWrapper>
  )
}
