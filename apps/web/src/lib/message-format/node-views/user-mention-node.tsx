import { NodeViewWrapper, type NodeViewProps } from '@tiptap/react'

import { MessageUserMention } from '#/components/chat/message-user-mention'
import { useMessageFormatContext } from '#/lib/message-format/message-format-context'

export function UserMentionNodeView({ node }: NodeViewProps) {
  const context = useMessageFormatContext()
  const userId = node.attrs.id as string
  const user = context.users?.[userId]
  const member =
    context.serverId && context.members
      ? context.members[`${context.serverId}:${userId}`]
      : undefined

  return (
    <NodeViewWrapper as="span" className="inline">
      <MessageUserMention
        userId={userId}
        user={user}
        server={context.server}
        serverId={context.serverId}
        serverName={context.serverName}
        member={member}
        currentUserId={context.currentUserId}
      />
    </NodeViewWrapper>
  )
}
