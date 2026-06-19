import type { Emoji, Message, User } from '@syrnike13/api-types'
import { FileIcon } from '#/components/icons'

import { renderMessageContent } from '#/lib/message-markdown'
import { cn } from '#/lib/utils'

type MessageSearchPreviewProps = {
  message: Message
  users: Record<string, User>
  emojis: Record<string, Emoji>
}

export function MessageSearchPreview({
  message,
  users,
  emojis,
}: MessageSearchPreviewProps) {
  const hasContent = Boolean(message.content?.trim())
  const attachments = message.attachments ?? []
  const hasAttachments = attachments.length > 0

  return (
    <div className="flex flex-col gap-1">
      {hasContent ? (
        <div className="line-clamp-2 text-sm">
          {renderMessageContent(message.content!, users, emojis)}
        </div>
      ) : null}
      {hasAttachments ? (
        <div className={cn('flex flex-col gap-1', hasContent && 'mt-1')}>
          {attachments.slice(0, 3).map((file) => (
            <div
              key={file._id}
              className="flex min-w-0 items-center gap-2 rounded-md border bg-background/40 px-2 py-1.5 text-sm"
            >
              <FileIcon className="size-3.5 shrink-0 text-muted-foreground" />
              <span className="truncate">{file.filename ?? file._id}</span>
            </div>
          ))}
          {attachments.length > 3 ? (
            <p className="text-xs text-muted-foreground">
              +{attachments.length - 3} влож.
            </p>
          ) : null}
        </div>
      ) : null}
      {!hasContent && !hasAttachments ? (
        <p className="text-sm italic text-muted-foreground">[без текста]</p>
      ) : null}
    </div>
  )
}
