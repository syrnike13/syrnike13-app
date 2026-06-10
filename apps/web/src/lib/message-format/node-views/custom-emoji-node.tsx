import { NodeViewWrapper, type NodeViewProps } from '@tiptap/react'

import { CustomEmoji } from '#/components/emoji/custom-emoji'
import { useMessageFormatContext } from '#/lib/message-format/message-format-context'

export function CustomEmojiNodeView({ node }: NodeViewProps) {
  const context = useMessageFormatContext()
  const emojiId = node.attrs.id as string
  const emoji = context.emojis?.[emojiId]

  return (
    <NodeViewWrapper as="span" className="inline align-middle">
      <CustomEmoji emojiId={emojiId} name={emoji?.name} />
    </NodeViewWrapper>
  )
}
