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

type MessageAttachmentsProps = {
  attachments: File[]
}

function formatFileSize(bytes: number) {
  const units = ['B', 'KB', 'MB', 'GB']
  let value = Math.max(0, bytes)
  let unitIndex = 0

  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024
    unitIndex += 1
  }

  if (unitIndex === 0) return `${Math.round(value)} ${units[unitIndex]}`

  const rounded = value >= 10 ? Math.round(value).toString() : value.toFixed(1)
  return `${rounded.replace(/\.0$/, '')} ${units[unitIndex]}`
}

export function MessageAttachments({ attachments }: MessageAttachmentsProps) {
  const [lightboxFile, setLightboxFile] = useState<File | null>(null)

  if (!attachments.length) return null

  return (
    <>
      <div className="flex flex-col gap-2">
        {attachments.map((file) => {
          const preview = attachmentPreviewUrl(file)
          const original = attachmentOriginalUrl(file)
          const aspectRatio = imageFileAspectRatio(file)

          if (isImageFile(file)) {
            return (
              <button
                key={file._id}
                type="button"
                className="block w-fit max-w-full overflow-hidden rounded-md border text-left"
                onClick={() => setLightboxFile(file)}
              >
                <FxImage
                  src={preview}
                  alt={file.filename ?? 'Изображение'}
                  aspectRatio={aspectRatio ?? undefined}
                  objectFit="contain"
                  wrapperClassName="max-h-80 cursor-zoom-in"
                />
              </button>
            )
          }

          return (
            <a
              key={file._id}
              href={original}
              target="_blank"
              rel="noreferrer noopener"
              className="flex items-center gap-2 rounded-md border bg-background/40 px-3 py-2 text-sm hover:bg-background/70"
            >
              <FileIcon className="size-4 shrink-0" />
              <span className="min-w-0">
                <span className="block truncate">
                  {file.filename ?? file._id}
                </span>
                <span className="block text-xs text-muted-foreground">
                  {formatFileSize(file.size)}
                </span>
              </span>
            </a>
          )
        })}
      </div>
      <ImageLightbox
        file={lightboxFile}
        open={lightboxFile !== null}
        onOpenChange={(open) => {
          if (!open) setLightboxFile(null)
        }}
      />
    </>
  )
}
