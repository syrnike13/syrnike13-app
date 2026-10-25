import { useTranslations } from '@syrnike13/ui/i18n'
import { EyeIcon, FileIcon, Trash2Icon } from '#/components/icons'

import { Button } from '@syrnike13/ui/primitives/button'
import {
  Attachment,
  AttachmentActions,
  AttachmentContent,
  AttachmentDescription,
  AttachmentMedia,
  AttachmentTitle,
} from '@syrnike13/ui/primitives/attachment'
import { FxImage } from '#/components/ui/fx-image'
import {
  stripSpoilerFilename,
  type PendingComposerFile,
} from '#/lib/composer-files'
import { formatFileSize } from '@syrnike13/ui/lib/file-size'
import type { CSSVars } from '#/lib/css-vars'
import { cn } from '#/lib/utils'

function attachmentState(pending: PendingComposerFile) {
  if (pending.status === 'error') return 'error' as const
  if (pending.status === 'uploading') return 'uploading' as const
  if (pending.status === 'uploaded') return 'done' as const
  return 'idle' as const
}

export function ComposerAttachmentStrip({
  files,
  sending,
  onRemove,
  onToggleSpoiler,
}: {
  files: PendingComposerFile[]
  sending: boolean
  onRemove: (id: string) => void
  onToggleSpoiler?: (id: string) => void
}) {
  const t = useTranslations('chat')
  if (files.length === 0) return null

  return (
    <div
      className="flex gap-3 overflow-x-auto px-3 pt-3 pb-1"
      aria-label={t('attachments')}
    >
      {files.map((pending) => (
        <ComposerAttachmentTile
          key={pending.id}
          pending={pending}
          removeDisabled={sending && pending.status !== 'uploading'}
          onRemove={() => onRemove(pending.id)}
          onToggleSpoiler={
            onToggleSpoiler ? () => onToggleSpoiler(pending.id) : undefined
          }
        />
      ))}
    </div>
  )
}

function ComposerAttachmentTile({
  pending,
  removeDisabled,
  onRemove,
  onToggleSpoiler,
}: {
  pending: PendingComposerFile
  removeDisabled: boolean
  onRemove: () => void
  onToggleSpoiler?: () => void
}) {
  const t = useTranslations('chat')
  const isSpoiler = Boolean(pending.spoiler)
  const displayName = stripSpoilerFilename(pending.file.name)
  const progress =
    pending.status === 'uploading'
      ? Math.round((pending.progress ?? 0) * 100)
      : null

  return (
    <Attachment
      orientation="vertical"
      state={attachmentState(pending)}
      className="w-28 shrink-0"
      aria-label={displayName}
    >
      <AttachmentMedia variant={pending.previewUrl ? 'image' : 'icon'}>
        {pending.previewUrl ? (
          <FxImage
            src={pending.previewUrl}
            alt={displayName}
            fill
            objectFit="cover"
            className={cn(isSpoiler && 'scale-105 blur-lg')}
          />
        ) : (
          <FileIcon aria-hidden="true" className="size-7" />
        )}

        {isSpoiler ? (
          <span className="absolute inset-0 z-10 flex items-center justify-center bg-background/55 text-xs font-semibold tracking-wide text-foreground uppercase">
            {t('spoiler')}
          </span>
        ) : null}

        {progress !== null ? (
          <span
            className="absolute inset-x-0 bottom-0 z-10 h-1 overflow-hidden bg-muted"
            aria-label={t('uploaded', { progress })}
          >
            <span
              className="block h-full w-(--upload-progress) bg-primary motion-width duration-150 motion-reduce:transition-none"
              style={{ '--upload-progress': `${progress}%` } as CSSVars}
            />
          </span>
        ) : null}

      </AttachmentMedia>

      <AttachmentActions>
        {onToggleSpoiler ? (
          <Button
            type="button"
            variant="secondary"
            size="icon-xs"
            onClick={onToggleSpoiler}
            aria-pressed={isSpoiler}
            aria-label={
              isSpoiler
                ? t('removeSpoilerFrom', { name: displayName })
                : t('markAsSpoiler', { name: displayName })
            }
            title={isSpoiler ? t('removeSpoiler') : t('spoiler')}
          >
            <EyeIcon className="size-3.5" />
          </Button>
        ) : null}
        <Button
          type="button"
          variant="destructive"
          size="icon-xs"
          disabled={removeDisabled}
          onClick={onRemove}
          aria-label={t('deleteAttachment', { name: displayName })}
        >
          <Trash2Icon className="size-3.5" />
        </Button>
      </AttachmentActions>

      <AttachmentContent>
        <AttachmentTitle title={displayName}>{displayName}</AttachmentTitle>
        <AttachmentDescription>
          {pending.status === 'error' && pending.error
            ? pending.error
            : progress !== null
              ? t('uploaded', { progress })
              : formatFileSize(pending.file.size)}
        </AttachmentDescription>
      </AttachmentContent>
    </Attachment>
  )
}
