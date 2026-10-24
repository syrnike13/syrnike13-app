import {
  useEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type ReactElement,
} from 'react'
import type { File, User } from '@syrnike13/api-types'
import { useTranslations } from '@syrnike13/ui/i18n'
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
} from '@syrnike13/ui/primitives/dialog'
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@syrnike13/ui/primitives/tooltip'
import { Button, buttonVariants } from '@syrnike13/ui/primitives/button'
import { UserAvatar } from '#/components/user/user-avatar'
import { attachmentOriginalUrl, attachmentPreviewUrl } from '#/lib/media'
import { useMessageTimestamp } from '#/lib/use-message-time'
import type { CSSVars } from '#/lib/css-vars'
import { cn } from '#/lib/utils'

export type ImageLightboxAuthor = {
  user?: User | null
  name: string
  nameColor?: string
  createdAt: Date
}

type ImageLightboxProps = {
  files: readonly File[]
  index: number
  onIndexChange: (index: number) => void
  open: boolean
  onOpenChange: (open: boolean) => void
  author?: ImageLightboxAuthor
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

const lightboxChromeClass =
  'rounded-xl bg-media-backdrop/95 text-on-media shadow-2xl'


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
      <TooltipTrigger render={children} />
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
  author,
}: ImageLightboxProps) {
  const t = useTranslations('media')
  const formatTimestamp = useMessageTimestamp()
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
  const title = file.filename ?? t('imageFallback')

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
      {/* design-allow restyle-shared: fullscreen media viewer surface */}
      <DialogContent
        aria-describedby={undefined}
        showCloseButton={false}
        className={cn(
          'fixed inset-0 z-300 flex max-w-none translate-x-0 translate-y-0 items-center justify-center overflow-hidden',
          'rounded-none bg-transparent p-0 ring-0 sm:max-w-none',
        )}
      >
        <DialogTitle className="sr-only">{title}</DialogTitle>

        <TooltipProvider delay={300}>
          {author ? (
            <div
              className="absolute top-5 left-4 z-10 flex max-w-lightbox-caption items-center gap-3"
              onClick={stopBubble}
            >
              <UserAvatar
                user={author.user}
                className="size-10 shrink-0"
                fallbackClassName="size-10"
                showPresence={false}
              />
              <div className="min-w-0">
                <p
                  className={cn(
                    'truncate text-sm font-semibold text-on-media',
                    author.nameColor && 'text-(--author-name-color)',
                  )}
                  style={
                    author.nameColor
                      ? ({
                          '--author-name-color': author.nameColor,
                        } as CSSVars)
                      : undefined
                  }
                >
                  {author.name}
                </p>
                <time
                  className="block truncate text-xs text-on-media/70"
                  dateTime={author.createdAt.toISOString()}
                >
                  {formatTimestamp(author.createdAt)}
                </time>
              </div>
            </div>
          ) : null}

          <div
            className={cn(
              'absolute top-5 right-16 z-10 flex items-center p-1',
              lightboxChromeClass,
            )}
            onClick={stopBubble}
          >
            <LightboxTooltip
              label={zoomed ? t('resetZoom') : t('zoomIn')}
            >
              <Button
                type="button"
                variant="media"
                size="icon-lg"
                aria-label={zoomed ? t('resetZoom') : t('zoomInImage')}
                aria-pressed={zoomed}
                onClick={() => {
                  if (zoomed) {
                    resetView()
                    return
                  }
                  setZoom(BUTTON_ZOOM)
                }}
              >
                <SearchIcon aria-hidden />
              </Button>
            </LightboxTooltip>
            <LightboxTooltip label={t('download')}>
              <a
                href={src}
                download={file.filename ?? 'image'}
                aria-label={t('downloadImage')}
                className={buttonVariants({ variant: 'media', size: 'icon-lg' })}
              >
                <DownloadIcon aria-hidden />
              </a>
            </LightboxTooltip>
            <LightboxTooltip label={t('openOriginal')}>
              <a
                href={src}
                target="_blank"
                rel="noreferrer noopener"
                aria-label={t('openOriginal')}
                className={buttonVariants({ variant: 'media', size: 'icon-lg' })}
              >
                <ExternalLinkIcon aria-hidden />
              </a>
            </LightboxTooltip>
          </div>

          <DialogClose
            render={
              <Button
                type="button"
                variant="overlay"
                size="icon-lg"
                shape="circle"
                aria-label={t('closeViewer')}
                className="absolute top-5 right-4 z-10"
                onClick={stopBubble}
              />
            }
          >
            <XIcon aria-hidden />
          </DialogClose>

          {hasGallery ? (
            <>
              <LightboxTooltip label={t('previous')} side="right">
                <Button
                  type="button"
                  variant="overlay"
                  size="icon-lg"
                  shape="circle"
                  aria-label={t('previousImage')}
                  className="absolute top-1/2 left-4 z-10 -translate-y-1/2"
                  onClick={(event) => {
                    stopBubble(event)
                    onIndexChange((index - 1 + files.length) % files.length)
                  }}
                >
                  <ChevronLeftIcon aria-hidden />
                </Button>
              </LightboxTooltip>
              <LightboxTooltip label={t('next')} side="left">
                <Button
                  type="button"
                  variant="overlay"
                  size="icon-lg"
                  shape="circle"
                  aria-label={t('nextImage')}
                  className="absolute top-1/2 right-4 z-10 -translate-y-1/2"
                  onClick={(event) => {
                    stopBubble(event)
                    onIndexChange((index + 1) % files.length)
                  }}
                >
                  <ChevronRightIcon aria-hidden />
                </Button>
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
              'lightbox-transform max-h-lightbox max-w-lightbox touch-none object-contain select-none',
              hasGallery && 'max-h-lightbox-image',
              zoomed
                ? dragging
                  ? 'cursor-grabbing'
                  : 'cursor-grab'
                : 'cursor-zoom-in',
            )}
            style={
              {
                '--lightbox-transform': imageTransform(offset, zoom),
              } as CSSVars
            }
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
              aria-label={t('attachments')}
              className="absolute inset-x-0 bottom-0 z-10 flex justify-center px-4 pb-4 pt-2"
              onClick={stopBubble}
            >
              <div
                className={cn(
                  'flex max-w-full items-center gap-1.5 overflow-x-auto',
                  'scrollbar-thin [&::-webkit-scrollbar]:h-1.5 [&::-webkit-scrollbar-thumb]:rounded-full [&::-webkit-scrollbar-thumb]:bg-on-media/20',
                )}
              >
                {files.map((item, itemIndex) => {
                  const active = itemIndex === index
                  const thumbTitle =
                    item.filename ?? t('imageNumber', { index: itemIndex + 1 })
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
                          ? 'opacity-100 ring-2 ring-inset ring-on-media'
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
