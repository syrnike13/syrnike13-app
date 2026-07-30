import { useState } from 'react'
import type { File } from '@syrnike13/api-types'
import { FileIcon } from '#/components/icons'

import { ImageLightbox } from '#/components/media/image-lightbox'
import { FxImage } from '#/components/ui/fx-image'
import {
  fileMosaicRatio,
  layoutAttachmentMosaic,
} from '#/features/chat/attachment-mosaic-layout'
import {
  attachmentOriginalUrl,
  attachmentPreviewUrl,
  imageFileAspectRatio,
  isImageFile,
} from '#/lib/media'
import { cn } from '#/lib/utils'

type MessageAttachmentsProps = {
  attachments: File[]
}

export function MessageAttachments({ attachments }: MessageAttachmentsProps) {
  const [lightboxIndex, setLightboxIndex] = useState<number | null>(null)
  const imageFiles = attachments.filter(isImageFile)
  const otherFiles = attachments.filter((file) => !isImageFile(file))

  if (!attachments.length) return null

  const mosaic =
    imageFiles.length > 1
      ? layoutAttachmentMosaic(imageFiles.map(fileMosaicRatio))
      : null

  return (
    <>
      <div className="flex flex-col gap-2">
        {imageFiles.length === 1 ? (
          <SingleImageAttachment
            file={imageFiles[0]!}
            onOpen={() => setLightboxIndex(0)}
          />
        ) : mosaic ? (
          <div
            data-attachment-mosaic={imageFiles.length}
            className="relative w-full max-w-md overflow-hidden rounded-md border"
            style={{ aspectRatio: mosaic.aspectRatio }}
          >
            {mosaic.tiles.map((tile) => {
              const file = imageFiles[tile.index]
              if (!file) return null
              return (
                <button
                  key={file._id}
                  type="button"
                  aria-label={file.filename ?? 'Изображение'}
                  className={cn(
                    'absolute overflow-hidden text-left focus-visible:z-10 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none',
                    'bg-border',
                  )}
                  style={{
                    left: `${tile.left}%`,
                    top: `${tile.top}%`,
                    width: `${tile.width}%`,
                    height: `${tile.height}%`,
                  }}
                  onClick={() => setLightboxIndex(tile.index)}
                >
                  <FxImage
                    src={attachmentPreviewUrl(file)}
                    alt={file.filename ?? 'Изображение'}
                    fill
                    objectFit="cover"
                    wrapperClassName="cursor-pointer"
                  />
                </button>
              )
            })}
          </div>
        ) : null}

        {otherFiles.map((file) => (
          <a
            key={file._id}
            href={attachmentOriginalUrl(file)}
            target="_blank"
            rel="noreferrer noopener"
            className="flex items-center gap-2 rounded-md border bg-background/40 px-3 py-2 text-sm hover:bg-background/70"
          >
            <FileIcon className="size-4 shrink-0" />
            <span className="truncate">{file.filename ?? file._id}</span>
          </a>
        ))}
      </div>
      <ImageLightbox
        files={imageFiles}
        index={lightboxIndex ?? 0}
        onIndexChange={setLightboxIndex}
        open={lightboxIndex !== null}
        onOpenChange={(open) => {
          if (!open) setLightboxIndex(null)
        }}
      />
    </>
  )
}

function SingleImageAttachment({
  file,
  onOpen,
}: {
  file: File
  onOpen: () => void
}) {
  const aspectRatio = imageFileAspectRatio(file)

  return (
    <button
      type="button"
      className="block w-fit max-w-full overflow-hidden rounded-md border text-left focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
      onClick={onOpen}
    >
      <FxImage
        src={attachmentPreviewUrl(file)}
        alt={file.filename ?? 'Изображение'}
        aspectRatio={aspectRatio ?? undefined}
        objectFit="contain"
        wrapperClassName="max-h-96 cursor-pointer sm:max-w-[28rem]"
      />
    </button>
  )
}
