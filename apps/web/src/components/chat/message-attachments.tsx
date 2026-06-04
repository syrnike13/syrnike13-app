import { useState } from 'react'
import type { File } from '@syrnike13/api-types'
import { FileIcon } from 'lucide-react'

import { ImageLightbox } from '#/components/media/image-lightbox'
import {
  attachmentOriginalUrl,
  attachmentPreviewUrl,
  isImageFile,
} from '#/lib/media'

type MessageAttachmentsProps = {
  attachments: File[]
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

          if (isImageFile(file)) {
            return (
              <button
                key={file._id}
                type="button"
                className="block overflow-hidden rounded-md border text-left"
                onClick={() => setLightboxFile(file)}
              >
                <img
                  src={preview}
                  alt={file.filename ?? 'Изображение'}
                  className="max-h-80 max-w-full cursor-zoom-in object-contain"
                  loading="lazy"
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
              <span className="truncate">{file.filename ?? file._id}</span>
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
