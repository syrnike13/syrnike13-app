import { useState } from 'react'
import type { File } from '@syrnike13/api-types'
import { FileIcon } from '#/components/icons'

import { ImageLightbox } from '#/components/media/image-lightbox'
import { FxImage } from '#/components/ui/fx-image'
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

const MOSAIC_MAX_VISIBLE = 4

function mosaicTileClass(count: number, index: number) {
  if (count === 3 && index === 0) return 'row-span-2'
  return undefined
}

export function MessageAttachments({ attachments }: MessageAttachmentsProps) {
  const [lightboxIndex, setLightboxIndex] = useState<number | null>(null)
  const imageFiles = attachments.filter(isImageFile)
  const otherFiles = attachments.filter((file) => !isImageFile(file))

  if (!attachments.length) return null

  const visibleImages =
    imageFiles.length > MOSAIC_MAX_VISIBLE
      ? imageFiles.slice(0, MOSAIC_MAX_VISIBLE)
      : imageFiles
  const hiddenCount = Math.max(0, imageFiles.length - visibleImages.length)

  return (
    <>
      <div className="flex flex-col gap-2">
        {imageFiles.length === 1 ? (
          <SingleImageAttachment
            file={imageFiles[0]!}
            onOpen={() => setLightboxIndex(0)}
          />
        ) : imageFiles.length > 1 ? (
          <div
            data-attachment-mosaic={imageFiles.length}
            className={cn(
              'grid max-w-md overflow-hidden rounded-md border',
              'gap-0.5 bg-border',
              visibleImages.length === 2 && 'grid-cols-2 aspect-[5/3]',
              visibleImages.length === 3 && 'grid-cols-2 grid-rows-2 h-72',
              visibleImages.length >= 4 && 'grid-cols-2 grid-rows-2 h-72',
            )}
          >
            {visibleImages.map((file, index) => {
              const isLastVisible = index === visibleImages.length - 1
              const showOverflow = isLastVisible && hiddenCount > 0
              return (
                <button
                  key={file._id}
                  type="button"
                  aria-label={
                    showOverflow
                      ? `${file.filename ?? 'Изображение'}, ещё ${hiddenCount}`
                      : (file.filename ?? 'Изображение')
                  }
                  className={cn(
                    'relative min-h-0 min-w-0 overflow-hidden text-left focus-visible:z-10 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none',
                    mosaicTileClass(visibleImages.length, index),
                  )}
                  onClick={() => setLightboxIndex(index)}
                >
                  <FxImage
                    src={attachmentPreviewUrl(file)}
                    alt={file.filename ?? 'Изображение'}
                    fill
                    objectFit="cover"
                    wrapperClassName="cursor-pointer"
                  />
                  {showOverflow ? (
                    <span className="absolute inset-0 flex items-center justify-center bg-black/55 text-2xl font-semibold text-white">
                      +{hiddenCount}
                    </span>
                  ) : null}
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
