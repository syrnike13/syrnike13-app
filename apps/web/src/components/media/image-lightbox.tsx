import {
  useEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type ReactElement,
} from 'react'
import type { File } from '@syrnike13/api-types'
import {
  ChevronLeftIcon,
  ChevronRightIcon,
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
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '#/components/ui/tooltip'
import { attachmentOriginalUrl, attachmentPreviewUrl } from '#/lib/media'
import { cn } from '#/lib/utils'

type ImageLightboxProps = {
  files: readonly File[]
  index: number
  onIndexChange: (index: number) => void
  open: boolean
  onOpenChange: (open: boolean) => void
}

type PanOffset = { x: number; y: number }

type DragState = {
  pointerId: number
  startX: number
  startY: number
  originX: number
  originY: number
  moved: boolean
}

const MIN_ZOOM = 1
const MAX_ZOOM = 4
const BUTTON_ZOOM = 2
const PAN_DRAG_THRESHOLD_PX = 3

const lightboxActionClass =
  'inline-flex size-9 items-center justify-center rounded-lg text-zinc-200 transition-colors hover:bg-white/10 focus-visible:ring-2 focus-visible:ring-white/60 focus-visible:outline-none'

const lightboxChromeClass =
  'rounded-xl bg-[#2b2d31]/95 text-zinc-200 shadow-2xl'

const lightboxNavClass = cn(
  'absolute top-1/2 z-10 inline-flex size-10 -translate-y-1/2 items-center justify-center',
  lightboxChromeClass,
  'transition-colors hover:bg-[#3a3c41] focus-visible:ring-2 focus-visible:ring-white/60 focus-visible:outline-none',
)

function stopBubble(event: { stopPropagation: () => void }) {
  event.stopPropagation()
}

function LightboxTooltip({
  label,
  side = 'bottom',
  children,
}: {
  label: string
  side?: 'top' | 'right' | 'bottom' | 'left'
  children: ReactElement
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>{children}</TooltipTrigger>
      <TooltipContent side={side} sideOffset={8}>
        {label}
      </TooltipContent>
    </Tooltip>
  )
}

function clampZoom(value: number) {
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, value))
}

function imageTransform(offset: PanOffset, zoom: number) {
  return `translate(${offset.x}px, ${offset.y}px) scale(${zoom})`
}

/** Смещение так, чтобы точка под курсором осталась на месте при смене zoom. */
function offsetAfterZoomTowardCursor({
  clientX,
  clientY,
  imageRect,
  offset,
  fromZoom,
  toZoom,
}: {
  clientX: number
  clientY: number
  imageRect: DOMRect
  offset: PanOffset
  fromZoom: number
  toZoom: number
}): PanOffset {
  if (fromZoom <= 0 || toZoom === fromZoom) return offset
  const visualCenterX = imageRect.left + imageRect.width / 2
  const visualCenterY = imageRect.top + imageRect.height / 2
  const layoutCenterX = visualCenterX - offset.x
  const layoutCenterY = visualCenterY - offset.y
  const cursorX = clientX - layoutCenterX
  const cursorY = clientY - layoutCenterY
  const ratio = toZoom / fromZoom
  return {
    x: cursorX - (cursorX - offset.x) * ratio,
    y: cursorY - (cursorY - offset.y) * ratio,
  }
}

export function ImageLightbox({
  files,
  index,
  onIndexChange,
  open,
  onOpenChange,
}: ImageLightboxProps) {
  const [zoom, setZoom] = useState(MIN_ZOOM)
  const [offset, setOffset] = useState<PanOffset>({ x: 0, y: 0 })
  const [dragging, setDragging] = useState(false)
  const dragRef = useRef<DragState | null>(null)
  const imageRef = useRef<HTMLImageElement>(null)
  const zoomRef = useRef(zoom)
  const offsetRef = useRef(offset)
  const activeThumbRef = useRef<HTMLButtonElement>(null)
  const file = files[index]
  const hasGallery = files.length > 1
  const zoomed = zoom > MIN_ZOOM + 0.01

  zoomRef.current = zoom
  offsetRef.current = offset

  const resetView = () => {
    setZoom(MIN_ZOOM)
    setOffset({ x: 0, y: 0 })
  }

  useEffect(() => {
    if (!open) return
    setZoom(MIN_ZOOM)
    setOffset({ x: 0, y: 0 })
  }, [file?._id, open])

  useEffect(() => {
    if (!zoomed) setOffset({ x: 0, y: 0 })
  }, [zoomed])

  useEffect(() => {
    if (!open || !hasGallery) return

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'ArrowLeft') {
        event.preventDefault()
        onIndexChange((index - 1 + files.length) % files.length)
        return
      }
      if (event.key === 'ArrowRight') {
        event.preventDefault()
        onIndexChange((index + 1) % files.length)
      }
    }

    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [files.length, hasGallery, index, onIndexChange, open])

  useEffect(() => {
    if (!hasGallery) return
    const thumb = activeThumbRef.current
    if (typeof thumb?.scrollIntoView !== 'function') return
    thumb.scrollIntoView({
      behavior: 'smooth',
      inline: 'center',
      block: 'nearest',
    })
  }, [hasGallery, index])

  if (!open || !file) return null

  const src = attachmentOriginalUrl(file)
  const title = file.filename ?? 'Изображение'

  const endDrag = (event: ReactPointerEvent<HTMLImageElement>) => {
    const drag = dragRef.current
    if (!drag || drag.pointerId !== event.pointerId) return
    const target = event.currentTarget
    if (
      typeof target.hasPointerCapture === 'function' &&
      target.hasPointerCapture(event.pointerId) &&
      typeof target.releasePointerCapture === 'function'
    ) {
      target.releasePointerCapture(event.pointerId)
    }
    dragRef.current = null
    setDragging(false)
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        aria-describedby={undefined}
        showCloseButton={false}
        themedSurface={false}
        overlayClassName="bg-black/85"
        className={cn(
          'fixed inset-0 top-0 left-0 z-[300] flex h-screen w-screen max-w-none translate-x-0 translate-y-0 items-center justify-center overflow-hidden',
          'rounded-none border-none bg-transparent p-0 shadow-none outline-none sm:max-w-none',
          'data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-100 data-[state=open]:zoom-in-100',
        )}
      >
        <DialogTitle className="sr-only">{title}</DialogTitle>

        <TooltipProvider delayDuration={300}>
          <div
            className={cn(
              'absolute top-5 right-16 z-10 flex items-center p-1',
              lightboxChromeClass,
            )}
            onClick={stopBubble}
          >
            {hasGallery ? (
              <span
                className="px-2 text-xs font-medium tabular-nums text-zinc-300"
                aria-live="polite"
              >
                {index + 1} / {files.length}
              </span>
            ) : null}
            <LightboxTooltip
              label={zoomed ? 'Сбросить масштаб' : 'Приблизить'}
            >
              <button
                type="button"
                aria-label={
                  zoomed ? 'Сбросить масштаб' : 'Приблизить изображение'
                }
                aria-pressed={zoomed}
                className={lightboxActionClass}
                onClick={() => {
                  if (zoomed) {
                    resetView()
                    return
                  }
                  setZoom(BUTTON_ZOOM)
                }}
              >
                <SearchIcon className="size-4" aria-hidden />
              </button>
            </LightboxTooltip>
            <LightboxTooltip label="Скачать">
              <a
                href={src}
                download={file.filename ?? 'image'}
                aria-label="Скачать изображение"
                className={lightboxActionClass}
              >
                <DownloadIcon className="size-4" aria-hidden />
              </a>
            </LightboxTooltip>
            <LightboxTooltip label="Открыть оригинал">
              <a
                href={src}
                target="_blank"
                rel="noreferrer noopener"
                aria-label="Открыть оригинал"
                className={lightboxActionClass}
              >
                <ExternalLinkIcon className="size-4" aria-hidden />
              </a>
            </LightboxTooltip>
          </div>

          <DialogClose asChild>
            <button
              type="button"
              aria-label="Закрыть просмотр изображения"
              className={cn(
                'absolute top-5 right-4 z-10 inline-flex size-10 items-center justify-center',
                lightboxChromeClass,
                'transition-colors hover:bg-[#3a3c41] focus-visible:ring-2 focus-visible:ring-white/60 focus-visible:outline-none',
              )}
              onClick={stopBubble}
            >
              <XIcon className="size-5" aria-hidden />
            </button>
          </DialogClose>

          {hasGallery ? (
            <>
              <LightboxTooltip label="Предыдущее" side="right">
                <button
                  type="button"
                  aria-label="Предыдущее изображение"
                  className={cn(lightboxNavClass, 'left-4')}
                  onClick={(event) => {
                    stopBubble(event)
                    onIndexChange((index - 1 + files.length) % files.length)
                  }}
                >
                  <ChevronLeftIcon className="size-5" aria-hidden />
                </button>
              </LightboxTooltip>
              <LightboxTooltip label="Следующее" side="left">
                <button
                  type="button"
                  aria-label="Следующее изображение"
                  className={cn(lightboxNavClass, 'right-4')}
                  onClick={(event) => {
                    stopBubble(event)
                    onIndexChange((index + 1) % files.length)
                  }}
                >
                  <ChevronRightIcon className="size-5" aria-hidden />
                </button>
              </LightboxTooltip>
            </>
          ) : null}

        <div
          className={cn(
            'flex h-full w-full items-center justify-center overflow-hidden p-6 sm:p-10',
            hasGallery && 'pb-28',
          )}
          onClick={() => {
            if (dragRef.current?.moved) return
            onOpenChange(false)
          }}
          onWheel={(event) => {
            const fromZoom = zoomRef.current
            const delta = -event.deltaY * 0.0015
            const toZoom = clampZoom(fromZoom + delta * fromZoom)
            if (toZoom === fromZoom) return

            if (toZoom <= MIN_ZOOM + 0.01) {
              resetView()
              return
            }

            const image = imageRef.current
            const nextOffset = image
              ? offsetAfterZoomTowardCursor({
                  clientX: event.clientX,
                  clientY: event.clientY,
                  imageRect: image.getBoundingClientRect(),
                  offset: offsetRef.current,
                  fromZoom,
                  toZoom,
                })
              : offsetRef.current

            setZoom(toZoom)
            setOffset(nextOffset)
          }}
        >
          <img
            ref={imageRef}
            src={src}
            alt={title}
            className={cn(
              'max-h-[calc(100vh-5rem)] max-w-[calc(100vw-5rem)] touch-none object-contain select-none',
              hasGallery && 'max-h-[calc(100vh-9rem)]',
              zoomed
                ? dragging
                  ? 'cursor-grabbing'
                  : 'cursor-grab'
                : 'cursor-zoom-in',
            )}
            style={{ transform: imageTransform(offset, zoom) }}
            draggable={false}
            loading="eager"
            decoding="async"
            onClick={(event) => {
              stopBubble(event)
            }}
            onPointerDown={(event) => {
              if (!zoomed || event.button !== 0) return
              stopBubble(event)
              dragRef.current = {
                pointerId: event.pointerId,
                startX: event.clientX,
                startY: event.clientY,
                originX: offset.x,
                originY: offset.y,
                moved: false,
              }
              event.currentTarget.setPointerCapture?.(event.pointerId)
              setDragging(true)
            }}
            onPointerMove={(event) => {
              const drag = dragRef.current
              if (!drag || drag.pointerId !== event.pointerId) return
              const dx = event.clientX - drag.startX
              const dy = event.clientY - drag.startY
              if (
                !drag.moved &&
                Math.hypot(dx, dy) >= PAN_DRAG_THRESHOLD_PX
              ) {
                drag.moved = true
              }
              setOffset({
                x: drag.originX + dx,
                y: drag.originY + dy,
              })
            }}
            onPointerUp={endDrag}
            onPointerCancel={endDrag}
          />
        </div>

        {hasGallery ? (
            <div
              role="list"
              aria-label="Миниатюры вложений"
              className="absolute inset-x-0 bottom-0 z-10 flex justify-center px-4 pb-4 pt-2"
              onClick={stopBubble}
            >
              <div
                className={cn(
                  'flex max-w-full items-center gap-1.5 overflow-x-auto',
                  '[scrollbar-width:thin] [&::-webkit-scrollbar]:h-1.5 [&::-webkit-scrollbar-thumb]:rounded-full [&::-webkit-scrollbar-thumb]:bg-white/20',
                )}
              >
                {files.map((item, itemIndex) => {
                  const active = itemIndex === index
                  const thumbTitle =
                    item.filename ?? `Изображение ${itemIndex + 1}`
                  const isFirst = itemIndex === 0
                  const isLast = itemIndex === files.length - 1
                  return (
                    <button
                      key={item._id}
                      ref={active ? activeThumbRef : undefined}
                      type="button"
                      role="listitem"
                      aria-label={thumbTitle}
                      aria-current={active ? 'true' : undefined}
                      className={cn(
                        'relative size-14 shrink-0 overflow-hidden transition-opacity',
                        isFirst && isLast && 'rounded-xl',
                        isFirst && !isLast && 'rounded-l-xl rounded-r-xs',
                        isLast && !isFirst && 'rounded-r-xl rounded-l-xs',
                        !isFirst && !isLast && 'rounded-xs',
                        active
                          ? 'opacity-100 ring-2 ring-inset ring-white'
                          : 'opacity-55 hover:opacity-85',
                      )}
                      onClick={() => onIndexChange(itemIndex)}
                    >
                      <img
                        src={attachmentPreviewUrl(item)}
                        alt=""
                        className="size-full object-cover"
                        draggable={false}
                        loading="lazy"
                        decoding="async"
                      />
                    </button>
                  )
                })}
              </div>
            </div>
          ) : null}
        </TooltipProvider>
      </DialogContent>
    </Dialog>
  )
}
