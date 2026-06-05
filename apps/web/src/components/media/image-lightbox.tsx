import type { File } from '@syrnike13/api-types'

import {
  Dialog,
  DialogContent,
  DialogTitle,
} from '#/components/ui/dialog'
import { FxImage } from '#/components/ui/fx-image'
import { attachmentOriginalUrl, imageFileAspectRatio } from '#/lib/media'

type ImageLightboxProps = {
  file: File | null
  open: boolean
  onOpenChange: (open: boolean) => void
}

export function ImageLightbox({ file, open, onOpenChange }: ImageLightboxProps) {
  if (!file) return null

  const src = attachmentOriginalUrl(file)
  const aspectRatio = imageFileAspectRatio(file)

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] max-w-[min(96vw,56rem)] border-none bg-transparent p-2 shadow-none">
        <DialogTitle className="sr-only">
          {file.filename ?? 'Изображение'}
        </DialogTitle>
        <FxImage
          src={src}
          alt={file.filename ?? 'Изображение'}
          aspectRatio={aspectRatio ?? undefined}
          objectFit="contain"
          wrapperClassName="mx-auto max-h-[85vh] max-w-full"
        />
      </DialogContent>
    </Dialog>
  )
}
