import type { File } from '@syrnike13/api-types'

import {
  Dialog,
  DialogContent,
  DialogTitle,
} from '#/components/ui/dialog'
import { attachmentOriginalUrl } from '#/lib/media'

type ImageLightboxProps = {
  file: File | null
  open: boolean
  onOpenChange: (open: boolean) => void
}

export function ImageLightbox({ file, open, onOpenChange }: ImageLightboxProps) {
  if (!file) return null

  const src = attachmentOriginalUrl(file)

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] max-w-[min(96vw,56rem)] border-none bg-transparent p-2 shadow-none">
        <DialogTitle className="sr-only">
          {file.filename ?? 'Изображение'}
        </DialogTitle>
        <img
          src={src}
          alt={file.filename ?? 'Изображение'}
          className="max-h-[85vh] w-full object-contain"
        />
      </DialogContent>
    </Dialog>
  )
}
