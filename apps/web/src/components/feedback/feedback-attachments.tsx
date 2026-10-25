import type { File } from '@syrnike13/api-types'
import { useTranslations } from '@syrnike13/ui/i18n'

import { MessageAttachments } from '#/components/chat/message-attachments'
import { formatFileSize } from '@syrnike13/ui/lib/file-size'
import { attachmentOriginalUrl } from '#/lib/media'

/** Feedback attachments: videos play inline, everything else renders like chat attachments. */
export function FeedbackAttachments({ attachments }: { attachments: File[] }) {
  const t = useTranslations('feedback.detail')
  const videos = attachments.filter((file) => file.metadata.type === 'Video')
  const others = attachments.filter((file) => file.metadata.type !== 'Video')

  return (
    <div className="flex flex-col gap-3">
      {videos.map((file) => (
        <figure
          key={file._id}
          className="overflow-hidden rounded-lg border border-shell-divider bg-muted/10"
        >
          <video
            src={attachmentOriginalUrl(file)}
            controls
            preload="metadata"
            className="aspect-video w-full bg-background"
            aria-label={t('videoAria', { name: file.filename })}
          />
          <figcaption className="flex min-w-0 items-center gap-2 px-3 py-2 text-xs text-muted-foreground">
            <span className="truncate">{file.filename}</span>
            <span className="ml-auto shrink-0 tabular-nums">
              {formatFileSize(file.size)}
            </span>
          </figcaption>
        </figure>
      ))}
      {others.length > 0 ? <MessageAttachments attachments={others} /> : null}
    </div>
  )
}
