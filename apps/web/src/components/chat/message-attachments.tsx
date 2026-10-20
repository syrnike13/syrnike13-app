import { useState } from 'react'
import type { File } from '@syrnike13/api-types'
import { FileIcon } from '#/components/icons'

import {
  ImageLightbox,
  type ImageLightboxAuthor,
} from '#/components/media/image-lightbox'
import { useTranslations } from '@syrnike13/ui/i18n'
import {
  Attachment,
  AttachmentContent,
  AttachmentDescription,
  AttachmentMedia,
  AttachmentTitle,
  AttachmentTrigger,
} from '@syrnike13/ui/primitives/attachment'

import { FxImage } from '#/components/ui/fx-image'
import {
  fileMosaicRatio,
  layoutAttachmentMosaic,
} from '#/features/chat/attachment-mosaic-layout'
import {
  isSpoilerFilename,
  stripSpoilerFilename,
} from '#/lib/composer-files'
import { formatFileSize } from '#/lib/file-size'
import {
  attachmentOriginalUrl,
  attachmentPreviewUrl,
  imageFileAspectRatio,
  isImageFile,
} from '#/lib/media'
import type { CSSVars } from '#/lib/css-vars'
import { cn } from '#/lib/utils'

type MessageAttachmentsProps = {
  attachments: File[]
  author?: ImageLightboxAuthor
}

export function MessageAttachments({
  attachments,
  author,
}: MessageAttachmentsProps) {
  const t = useTranslations('chat')
  const [lightboxIndex, setLightboxIndex] = useState<number | null>(null)
  const [revealedSpoilers, setRevealedSpoilers] = useState<
    Record<string, true>
  >({})
  const imageFiles = attachments.filter(isImageFile)
  const otherFiles = attachments.filter((file) => !isImageFile(file))

  if (!attachments.length) return null

  const mosaic =
    imageFiles.length > 1
      ? layoutAttachmentMosaic(imageFiles.map(fileMosaicRatio))
      : null

  function revealSpoiler(fileId: string) {
    setRevealedSpoilers((current) => ({ ...current, [fileId]: true }))
  }

  return (
    <>
      <div className="flex flex-col gap-2">
        {imageFiles.length === 1 ? (
          <SingleImageAttachment
            file={imageFiles[0]!}
            spoilerRevealed={Boolean(revealedSpoilers[imageFiles[0]!._id])}
            onRevealSpoiler={() => revealSpoiler(imageFiles[0]!._id)}
            onOpen={() => setLightboxIndex(0)}
          />
        ) : mosaic ? (
          <div
            data-attachment-mosaic={imageFiles.length}
            className="relative aspect-(--mosaic-aspect) max-h-87.5 w-(--mosaic-width) max-w-full overflow-hidden rounded-md border"
            style={
              {
                '--mosaic-aspect': mosaic.aspectRatio,
                // Максимум 550×350: ширина выводится из ratio до загрузки.
                '--mosaic-width': `min(100%, 34.375rem, calc(21.875rem * ${mosaic.aspectRatio}))`,
              } as CSSVars
            }
          >
            {mosaic.tiles.map((tile) => {
              const file = imageFiles[tile.index]
              if (!file) return null
              const spoiler =
                isSpoilerFilename(file.filename) &&
                !revealedSpoilers[file._id]
              return (
                <button
                  key={file._id}
                  type="button"
                  aria-label={
                    spoiler
                      ? t('spoilerShow')
                      : (file.filename ?? t('image'))
                  }
                  className={cn(
                    'absolute left-(--tile-left) top-(--tile-top) h-(--tile-height) w-(--tile-width) overflow-hidden text-left focus-visible:z-10 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none',
                    'bg-border',
                  )}
                  style={
                    {
                      '--tile-left': `${tile.left}%`,
                      '--tile-top': `${tile.top}%`,
                      '--tile-width': `${tile.width}%`,
                      '--tile-height': `${tile.height}%`,
                    } as CSSVars
                  }
                  onClick={() => {
                    if (spoiler) {
                      revealSpoiler(file._id)
                      return
                    }
                    setLightboxIndex(tile.index)
                  }}
                >
                  <FxImage
                    src={attachmentPreviewUrl(file)}
                    alt={stripSpoilerFilename(file.filename) || t('image')}
                    fill
                    objectFit="cover"
                    className={cn(spoiler && 'scale-105 blur-xl')}
                    wrapperClassName="cursor-pointer"
                  />
                  {spoiler ? (
                    <span className="absolute inset-0 flex items-center justify-center bg-background/55 text-xs font-semibold tracking-wide text-foreground uppercase">
                      {t('spoiler')}
                    </span>
                  ) : null}
                </button>
              )
            })}
          </div>
        ) : null}

        {otherFiles.map((file) => {
          const spoiler =
            isSpoilerFilename(file.filename) && !revealedSpoilers[file._id]
          const label = stripSpoilerFilename(file.filename) || file._id

          return (
            <Attachment key={file._id} size="sm" className="max-w-md">
              <AttachmentMedia>
                <FileIcon />
              </AttachmentMedia>
              <AttachmentContent>
                <AttachmentTitle className={cn(spoiler && 'uppercase')}>
                  {spoiler ? t('spoiler') : label}
                </AttachmentTitle>
                <AttachmentDescription>
                  {formatFileSize(file.size)}
                </AttachmentDescription>
              </AttachmentContent>
              {spoiler ? (
                <AttachmentTrigger
                  onClick={() => revealSpoiler(file._id)}
                  aria-label={t('spoilerShow')}
                />
              ) : (
                <AttachmentTrigger
                  render={
                    <a
                      href={attachmentOriginalUrl(file)}
                      target="_blank"
                      rel="noreferrer noopener"
                      aria-label={label}
                    />
                  }
                />
              )}
            </Attachment>
          )
        })}
      </div>
      <ImageLightbox
        files={imageFiles}
        index={lightboxIndex ?? 0}
        onIndexChange={setLightboxIndex}
        open={lightboxIndex !== null}
        onOpenChange={(open) => {
          if (!open) setLightboxIndex(null)
        }}
        author={author}
      />
    </>
  )
}

function SingleImageAttachment({
  file,
  spoilerRevealed,
  onRevealSpoiler,
  onOpen,
}: {
  file: File
  spoilerRevealed: boolean
  onRevealSpoiler: () => void
  onOpen: () => void
}) {
  const t = useTranslations('chat')
  /** Всегда резервируем box до decode: без ratio intrinsic width ≈ 0. */
  const aspectRatio = imageFileAspectRatio(file) ?? 1
  const spoiler = isSpoilerFilename(file.filename) && !spoilerRevealed
  const label = stripSpoilerFilename(file.filename) || t('image')

  return (
    <button
      type="button"
      data-attachment-single
      data-aspect-ratio={String(aspectRatio)}
      aria-label={spoiler ? t('spoilerShow') : label}
      className="relative block aspect-(--single-aspect) max-h-87.5 w-(--single-width) max-w-full overflow-hidden rounded-md border bg-border text-left focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
      style={
        {
          '--single-aspect': aspectRatio,
          // Максимум 550×350. Ширина до load выводится из ratio,
          // иначе w-fit схлопывается и лента прыгает.
          '--single-width': `min(100%, 34.375rem, calc(21.875rem * ${aspectRatio}))`,
        } as CSSVars
      }
      onClick={() => {
        if (spoiler) {
          onRevealSpoiler()
          return
        }
        onOpen()
      }}
    >
      <FxImage
        src={attachmentPreviewUrl(file)}
        alt={label}
        fill
        objectFit="contain"
        className={cn(spoiler && 'scale-105 blur-xl')}
        wrapperClassName="cursor-pointer"
      />
      {spoiler ? (
        <span className="absolute inset-0 flex items-center justify-center bg-background/55 text-sm font-semibold tracking-wide text-foreground uppercase">
          {t('spoiler')}
        </span>
      ) : null}
    </button>
  )
}
