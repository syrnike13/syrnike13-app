import { MessageMarkdownRenderer } from '#/lib/message-format/markdown-renderer'
import type { MessageFormatContext } from '#/lib/message-format/types'

type MessageContentViewProps = {
  content: string
  context?: MessageFormatContext
}

export function MessageContentView({
  content,
  context = {},
}: MessageContentViewProps) {
  if (!content) return null

  return (
    <div className="message-content text-sm leading-relaxed break-words">
      <MessageMarkdownRenderer content={content} context={context} />
    </div>
  )
}

/** @deprecated Use MessageContentView */
export function renderMessageContent(
  content: string,
  users?: MessageFormatContext['users'],
  emojis?: MessageFormatContext['emojis'],
  options?: Omit<MessageFormatContext, 'users' | 'emojis'>,
) {
  return (
    <MessageContentView
      content={content}
      context={{
        users,
        emojis,
        ...options,
      }}
    />
  )
}
