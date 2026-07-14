import { useEffect, useState } from 'react'
import type { File } from '@syrnike13/api-types'
import {
  DownloadIcon,
  ExternalLinkIcon,
  SearchIcon,
  XIcon,
} from '#/components/icons'

import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogTitle,
} from '#/components/ui/dialog'
import { attachmentOriginalUrl } from '#/lib/media'
import { cn } from '#/lib/utils'

type ImageLightboxProps = {
  file: File | null
  open: boolean
  onOpenChange: (open: boolean) => void
}

const lightboxActionClass =
  'inline-flex size-9 items-center justify-center rounded-lg text-zinc-200 transition-colors hover:bg-white/10 focus-visible:ring-2 focus-visible:ring-white/60 focus-visible:outline-none'

export function ImageLightbox({ file, open, onOpenChange }: ImageLightboxProps) {
  const [zoomed, setZoomed] = useState(false)

  useEffect(() => {
    if (open) setZoomed(false)
  }, [file?._id, open])

  if (!file) return null

  const src = attachmentOriginalUrl(file)
  const title = file.filename ?? 'Изображение'

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        aria-describedby={undefined}
        showCloseButton={false}
        overlayClassName="bg-black/85"
        className={cn(
          'fixed inset-0 top-0 left-0 z-[300] flex h-screen w-screen max-w-none translate-x-0 translate-y-0 items-center justify-center overflow-hidden',
          'rounded-none border-none bg-transparent p-0 shadow-none outline-none sm:max-w-none',
          'data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-100 data-[state=open]:zoom-in-100',
        )}
      >
        <DialogTitle className="sr-only">{title}</DialogTitle>

        <div className="absolute top-5 right-16 z-10 flex items-center rounded-xl bg-[#2b2d31]/95 p-1 shadow-2xl backdrop-blur">
          <button
            type="button"
            aria-label={
              zoomed ? 'Уменьшить изображение' : 'Увеличить изображение'
            }
            aria-pressed={zoomed}
            className={lightboxActionClass}
            onClick={() => setZoomed((value) => !value)}
          >
            <SearchIcon className="size-4" aria-hidden />
          </button>
          <a
            href={src}
            download={file.filename ?? 'image'}
            aria-label="Скачать изображение"
            className={lightboxActionClass}
          >
            <DownloadIcon className="size-4" aria-hidden />
          </a>
          <a
            href={src}
            target="_blank"
            rel="noreferrer noopener"
            aria-label="Открыть оригинал"
            className={lightboxActionClass}
          >
            <ExternalLinkIcon className="size-4" aria-hidden />
          </a>
        </div>

        <DialogClose asChild>
          <button
            type="button"
            aria-label="Закрыть просмотр изображения"
            className="absolute top-5 right-4 z-10 inline-flex size-10 items-center justify-center rounded-lg bg-[#2b2d31]/95 text-zinc-200 shadow-2xl transition-colors hover:bg-white/10 focus-visible:ring-2 focus-visible:ring-white/60 focus-visible:outline-none"
          >
            <XIcon className="size-5" aria-hidden />
          </button>
        </DialogClose>

        <div className="flex h-full w-full items-center justify-center p-6 sm:p-10">
          <img
            src={src}
            alt={title}
            className={cn(
              'max-h-[calc(100vh-5rem)] max-w-[calc(100vw-5rem)] cursor-pointer object-contain transition-transform duration-150 ease-out',
              zoomed && 'scale-110',
            )}
            draggable={false}
            loading="eager"
            decoding="async"
            onClick={() => setZoomed((value) => !value)}
          />
        </div>
      </DialogContent>
    </Dialog>
  )
}
