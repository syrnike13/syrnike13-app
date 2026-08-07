import { NodeViewWrapper, type NodeViewProps } from '@tiptap/react'

import { CustomEmoji } from '#/components/emoji/custom-emoji'
import { useMessageFormatContext } from '#/lib/message-format/message-format-context'
import { readStringNodeAttribute } from '#/lib/message-format/node-attrs'

export function CustomEmojiNodeView({ node }: NodeViewProps) {
  const context = useMessageFormatContext()
  const emojiId = readStringNodeAttribute(node.attrs, 'id') ?? ''
  const emoji = context.emojis?.[emojiId]

  return (
    <NodeViewWrapper as="span" className="inline align-middle">
      <CustomEmoji emojiId={emojiId} name={emoji?.name} />
    </NodeViewWrapper>
  )
}
