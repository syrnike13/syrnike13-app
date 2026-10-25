import { useEffect, useRef, useState, type PointerEvent } from 'react'
import { useTranslations } from '@syrnike13/ui/i18n'

import { ImageIcon, RotateCwIcon } from '#/components/icons'
import { Button } from '@syrnike13/ui/primitives/button'
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@syrnike13/ui/primitives/dialog'
import { Slider } from '@syrnike13/ui/primitives/slider'
import type { CSSVars } from '#/lib/css-vars'
import { cn } from '#/lib/utils'

export type ImageCropShape =
  | { kind: 'circle' }
  | { kind: 'rect'; aspect: number }

/** Crop frame inside the 400×320 stage and the exported size. */
function frameGeometry(shape: ImageCropShape) {
  if (shape.kind === 'circle') {
    return { width: 256, height: 256, outWidth: 512, outHeight: 512 }
  }
  const width = 352
  return {
    width,
    height: Math.round(width / shape.aspect),
    outWidth: 1360,
    outHeight: Math.round(1360 / shape.aspect),
  }
}

const MAX_ZOOM = 3

/**
 * Discord-style image editor before upload: drag to move, slider to zoom,
 * rotate by 90°. The frame always stays covered by the image. Exports a PNG
 * of the framed area.
 */
export function ImageCropDialog({
  file,
  shape,
  onCancel,
  onApply,
}: {
  /** The picked image; null closes the dialog. */
  file: File | null
  shape: ImageCropShape
  onCancel: () => void
  onApply: (cropped: File) => void
}) {
  const t = useTranslations('media.crop')
  const frame = frameGeometry(shape)
  const [url, setUrl] = useState<string | null>(null)
  const [image, setImage] = useState<HTMLImageElement | null>(null)
  const [zoom, setZoom] = useState(1)
  const [rotation, setRotation] = useState(0)
  const [offset, setOffset] = useState({ x: 0, y: 0 })
  const dragRef = useRef<{ x: number; y: number; ox: number; oy: number } | null>(
    null,
  )

  useEffect(() => {
    if (!file) return
    const next = URL.createObjectURL(file)
    setUrl(next)
    setImage(null)
    setZoom(1)
    setRotation(0)
    setOffset({ x: 0, y: 0 })
    const img = new Image()
    img.onload = () => setImage(img)
    img.src = next
    return () => URL.revokeObjectURL(next)
  }, [file])

  const rotated = rotation % 180 !== 0
  const naturalWidth = image?.naturalWidth ?? 1
  const naturalHeight = image?.naturalHeight ?? 1
  const effectiveWidth = rotated ? naturalHeight : naturalWidth
  const effectiveHeight = rotated ? naturalWidth : naturalHeight
  const coverScale = Math.max(
    frame.width / effectiveWidth,
    frame.height / effectiveHeight,
  )
  const scale = coverScale * zoom

  const clamp = (x: number, y: number) => {
    const maxX = Math.max(0, (effectiveWidth * scale - frame.width) / 2)
    const maxY = Math.max(0, (effectiveHeight * scale - frame.height) / 2)
    return {
      x: Math.min(maxX, Math.max(-maxX, x)),
      y: Math.min(maxY, Math.max(-maxY, y)),
    }
  }
  const position = clamp(offset.x, offset.y)

  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    event.currentTarget.setPointerCapture(event.pointerId)
    dragRef.current = {
      x: event.clientX,
      y: event.clientY,
      ox: position.x,
      oy: position.y,
    }
  }
  const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current
    if (!drag) return
    setOffset(
      clamp(drag.ox + event.clientX - drag.x, drag.oy + event.clientY - drag.y),
    )
  }
  const onPointerUp = () => {
    dragRef.current = null
  }

  const apply = () => {
    if (!image || !file) return
    const canvas = document.createElement('canvas')
    canvas.width = frame.outWidth
    canvas.height = frame.outHeight
    const context = canvas.getContext('2d')
    if (!context) return
    const k = frame.outWidth / frame.width
    context.imageSmoothingQuality = 'high'
    context.translate(
      frame.outWidth / 2 + position.x * k,
      frame.outHeight / 2 + position.y * k,
    )
    context.rotate((rotation * Math.PI) / 180)
    context.scale(scale * k, scale * k)
    context.drawImage(image, -naturalWidth / 2, -naturalHeight / 2)
    canvas.toBlob((blob) => {
      if (!blob) return
      const name = file.name.replace(/\.[^.]+$/, '') || 'image'
      onApply(new File([blob], `${name}.png`, { type: 'image/png' }))
    }, 'image/png')
  }

  return (
    <Dialog
      open={file !== null}
      onOpenChange={(open) => {
        if (!open) onCancel()
      }}
    >
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{t('title')}</DialogTitle>
        </DialogHeader>

        {/* eslint-disable-next-line design/no-lookalike -- drag surface for panning the image */}
        <div
          className="relative h-80 cursor-grab touch-none overflow-hidden rounded-lg bg-media-backdrop select-none active:cursor-grabbing"
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerUp}
        >
          {url && image ? (
            <img
              src={url}
              alt=""
              draggable={false}
              className="pointer-events-none absolute top-1/2 left-1/2 h-(--crop-h) w-(--crop-w) max-w-none crop-transform"
              style={
                {
                  '--crop-w': `${naturalWidth}px`,
                  '--crop-h': `${naturalHeight}px`,
                  '--crop-transform': `translate(-50%, -50%) translate(${position.x}px, ${position.y}px) rotate(${rotation}deg) scale(${scale})`,
                } as CSSVars
              }
            />
          ) : null}
          {/* The frame: everything outside is dimmed by a wide shadow. */}
          <div
            aria-hidden
            className={cn(
              'pointer-events-none absolute top-1/2 left-1/2 h-(--frame-h) w-(--frame-w) -translate-1/2 border-2 border-on-media crop-frame-mask',
              shape.kind === 'circle' ? 'rounded-full' : 'rounded-md',
            )}
            style={
              {
                '--frame-w': `${frame.width}px`,
                '--frame-h': `${frame.height}px`,
              } as CSSVars
            }
          />
        </div>

        <div className="flex items-center gap-3">
          <ImageIcon className="size-4 shrink-0 text-muted-foreground" aria-hidden />
          <Slider
            aria-label={t('zoom')}
            min={1}
            max={MAX_ZOOM}
            step={0.01}
            value={[zoom]}
            onValueChange={(next) => {
              const value = typeof next === 'number' ? next : next[0]
              if (value != null) setZoom(value)
            }}
          />
          <ImageIcon className="size-6 shrink-0 text-muted-foreground" aria-hidden />
          <Button
            type="button"
            variant="ghost"
            size="icon"
            aria-label={t('rotate')}
            title={t('rotate')}
            onClick={() => {
              setRotation((current) => (current + 90) % 360)
              setOffset({ x: 0, y: 0 })
            }}
          >
            <RotateCwIcon />
          </Button>
        </div>

        <DialogFooter className="sm:justify-between">
          <Button
            type="button"
            variant="link"
            onClick={() => {
              setZoom(1)
              setRotation(0)
              setOffset({ x: 0, y: 0 })
            }}
          >
            {t('reset')}
          </Button>
          <div className="flex gap-2">
            <Button type="button" variant="ghost" onClick={onCancel}>
              {t('cancel')}
            </Button>
            <Button type="button" disabled={!image} onClick={apply}>
              {t('apply')}
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

type CropRequest = {
  file: File
  shape: ImageCropShape
  onApply: (cropped: File) => void
}

/**
 * Crop before upload: `cropImage(file, shape, onApply)` opens the editor and
 * calls `onApply` with the framed PNG. Animated GIFs skip the editor — a
 * canvas crop would drop their frames. Render `cropDialog` once.
 */
export function useImageCropper() {
  const [request, setRequest] = useState<CropRequest | null>(null)

  const cropImage = (
    file: File,
    shape: ImageCropShape,
    onApply: (cropped: File) => void,
  ) => {
    if (file.type === 'image/gif') {
      onApply(file)
      return
    }
    setRequest({ file, shape, onApply })
  }

  const cropDialog = (
    <ImageCropDialog
      file={request?.file ?? null}
      shape={request?.shape ?? { kind: 'circle' }}
      onCancel={() => setRequest(null)}
      onApply={(cropped) => {
        const current = request
        setRequest(null)
        current?.onApply(cropped)
      }}
    />
  )

  return { cropImage, cropDialog }
}
