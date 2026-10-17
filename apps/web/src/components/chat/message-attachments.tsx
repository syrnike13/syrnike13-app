import { useState } from 'react'
import type { File } from '@syrnike13/api-types'
import { FileIcon } from '#/components/icons'

import {
  ImageLightbox,
  type ImageLightboxAuthor,
} from '#/components/media/image-lightbox'
import { useTranslations } from '@syrnike13/ui/i18n'

import { FxImage } from '#/components/ui/fx-image'
import {
  fileMosaicRatio,
  layoutAttachmentMosaic,
} from '#/features/chat/attachment-mosaic-layout'
import {
  isSpoilerFilename,
  stripSpoilerFilename,
} from '#/lib/composer-files'
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
            className="relative aspect-(--mosaic-aspect) w-full max-w-md overflow-hidden rounded-md border"
            style={{ '--mosaic-aspect': mosaic.aspectRatio } as CSSVars}
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
          if (spoiler) {
            return (
              <button
                key={file._id}
                type="button"
                className="flex items-center gap-2 rounded-md border bg-background/40 px-3 py-2 text-sm hover:bg-background/70"
                onClick={() => revealSpoiler(file._id)}
              >
                <FileIcon className="size-4 shrink-0" />
                <span className="truncate font-semibold uppercase">{t('spoiler')}</span>
              </button>
            )
          }
          return (
            <a
              key={file._id}
              href={attachmentOriginalUrl(file)}
              target="_blank"
              rel="noreferrer noopener"
              className="flex items-center gap-2 rounded-md border bg-background/40 px-3 py-2 text-sm hover:bg-background/70"
            >
              <FileIcon className="size-4 shrink-0" />
              <span className="truncate">{label}</span>
            </a>
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
      className="relative block aspect-(--single-aspect) max-h-96 w-(--single-width) max-w-full overflow-hidden rounded-md border bg-border text-left focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none sm:max-w-112"
      style={
        {
          '--single-aspect': aspectRatio,
          // Ширина до load: min(100%, 28rem, max-h-96 * ratio), иначе w-fit схлопывается.
          '--single-width': `min(100%, 28rem, calc(24rem * ${aspectRatio}))`,
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
