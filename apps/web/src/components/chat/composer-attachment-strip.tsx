import { EyeIcon, FileIcon, Trash2Icon } from '#/components/icons'

import { Button } from '#/components/ui/button'
import { FxImage } from '#/components/ui/fx-image'
import {
  stripSpoilerFilename,
  type PendingComposerFile,
} from '#/lib/composer-files'
import { cn } from '#/lib/utils'

const TILE_PREVIEW_CLASS = 'size-28 shrink-0 overflow-hidden rounded-lg'

export function ComposerAttachmentStrip({
  files,
  sending,
  onRemove,
  onToggleSpoiler,
}: {
  files: PendingComposerFile[]
  sending: boolean
  onRemove: (id: string) => void
  onToggleSpoiler: (id: string) => void
}) {
  if (files.length === 0) return null

  return (
    <div
      className="flex gap-3 overflow-x-auto px-3 pt-4"
      aria-label="Вложения"
    >
      {files.map((pending) => (
        <ComposerAttachmentTile
          key={pending.id}
          pending={pending}
          removeDisabled={sending && pending.status !== 'uploading'}
          onRemove={() => onRemove(pending.id)}
          onToggleSpoiler={() => onToggleSpoiler(pending.id)}
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
  onToggleSpoiler: () => void
}) {
  const hasError = pending.status === 'error'
  const isSpoiler = Boolean(pending.spoiler)
  const displayName = stripSpoilerFilename(pending.file.name)
  const progress =
    pending.status === 'uploading'
      ? Math.round((pending.progress ?? 0) * 100)
      : null

  return (
    <div className="relative w-28 shrink-0">
      <div className="relative">
        {pending.previewUrl ? (
          <div className={cn(TILE_PREVIEW_CLASS, 'relative bg-muted')}>
            <FxImage
              src={pending.previewUrl}
              alt={displayName}
              fill
              rounded="lg"
              objectFit="cover"
              className={cn(isSpoiler && 'scale-105 blur-lg')}
            />
            {isSpoiler ? (
              <span className="absolute inset-0 flex items-center justify-center bg-background/50 text-[10px] font-semibold tracking-wide text-foreground uppercase">
                Спойлер
              </span>
            ) : null}
          </div>
        ) : (
          <div
            className={cn(
              TILE_PREVIEW_CLASS,
              'relative flex flex-col items-center justify-center gap-1.5 bg-muted px-2 text-center',
              isSpoiler && 'bg-foreground/20',
            )}
          >
            <FileIcon
              aria-hidden="true"
              className={cn(
                'size-7 shrink-0 text-muted-foreground',
                isSpoiler && 'opacity-40',
              )}
            />
            <span className="text-[10px] leading-none text-muted-foreground">
              {formatFileSize(pending.file.size)}
            </span>
            {isSpoiler ? (
              <span className="absolute inset-0 flex items-center justify-center bg-background/50 text-[10px] font-semibold tracking-wide text-foreground uppercase">
                Спойлер
              </span>
            ) : null}
          </div>
        )}

        {progress !== null ? (
          <span
            className="absolute inset-x-0 bottom-0 h-1 overflow-hidden rounded-b-lg bg-muted"
            aria-label={`Загружено ${progress}%`}
          >
            <span
              className="block h-full bg-primary transition-[width] duration-150 motion-reduce:transition-none"
              style={{ width: `${progress}%` }}
            />
          </span>
        ) : null}

        <div className="absolute -top-2 -right-1 z-10 flex items-center gap-0.5 rounded-md bg-popover p-0.5 text-popover-foreground shadow-md">
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className={cn(
              'size-7 rounded-sm hover:bg-foreground/10',
              isSpoiler
                ? 'text-primary hover:text-primary'
                : 'text-muted-foreground hover:text-foreground',
            )}
            onClick={onToggleSpoiler}
            aria-pressed={isSpoiler}
            aria-label={
              isSpoiler
                ? `Убрать спойлер с ${displayName}`
                : `Пометить ${displayName} как спойлер`
            }
            title={isSpoiler ? 'Убрать спойлер' : 'Спойлер'}
          >
            <EyeIcon className="size-3.5" />
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="size-7 rounded-sm text-destructive hover:bg-destructive/15 hover:text-destructive"
            disabled={removeDisabled}
            onClick={onRemove}
            aria-label={`Удалить вложение ${displayName}`}
          >
            <Trash2Icon className="size-3.5" />
          </Button>
        </div>
      </div>

      <p
        className="mt-1.5 truncate text-xs leading-tight text-muted-foreground"
        title={displayName}
      >
        {displayName}
      </p>

      {hasError && pending.error ? (
        <p
          className="mt-0.5 truncate text-[11px] leading-tight text-destructive"
          title={pending.error}
        >
          {pending.error}
        </p>
      ) : null}
    </div>
  )
}

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}
