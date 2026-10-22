import { useEffect, useRef, useState, type CSSProperties } from 'react'
import { useTranslations } from '@syrnike13/ui/i18n'
import { Spinner } from '@syrnike13/ui/primitives/spinner'
import type { VideoTrack } from 'livekit-client'

import type { VoiceStageMediaTrack } from '#/features/voice/voice-context'
import type { NativeVideoTrackAdapter } from '#/features/voice/native-video-registry'
import { cn } from '#/lib/utils'

export const VOICE_STAGE_MEDIA_ID_ATTR = 'data-voice-stage-media-id'

function applyMediaElementPresentation(
  element: HTMLElement,
  className: string | undefined,
  fit: 'contain' | 'cover',
  style: CSSProperties | undefined,
) {
  element.className = cn(
    'absolute inset-0 size-full',
    fit === 'contain' ? 'object-contain' : 'object-cover',
    className,
  )
  element.removeAttribute('style')
  if (style) {
    Object.assign(element.style, style)
  }
}

/** How long a replaced video may stay on screen waiting for its successor. */
const MEDIA_SWAP_FALLBACK_MS = 3_000

/** Frees every media element left in the host once the component unmounts. */
function useReleaseMediaOnUnmount(hostRef: { current: HTMLElement | null }) {
  useEffect(() => {
    const host = hostRef.current
    return () => {
      if (host) retireStaleMediaElements(host, null)
    }
  }, [hostRef])
}

function retireStaleMediaElements(
  host: HTMLElement,
  current: HTMLElement | null,
) {
  for (const element of [...host.children]) {
    if (element === current) continue
    element.remove()
    if (element instanceof HTMLCanvasElement) {
      element.width = 0
      element.height = 0
    } else if (element instanceof HTMLVideoElement) {
      element.srcObject = null
    }
  }
}

export function VoiceStageVideo({
  track,
  mediaId,
  className,
  fit = 'cover',
  style,
  onVideoSizeChange,
}: {
  track: VoiceStageMediaTrack
  mediaId: string
  className?: string
  fit?: 'contain' | 'cover'
  style?: CSSProperties
  onVideoSizeChange?: (size: { width: number; height: number }) => void
}) {
  // A replacement track is attached but has not drawn its first frame yet.
  const [swapping, setSwapping] = useState(false)
  const video =
    track.backend === 'native' ? (
      <NativeVoiceStageCanvas
        track={track.track}
        mediaId={mediaId}
        className={className}
        fit={fit}
        style={style}
        onVideoSizeChange={onVideoSizeChange}
        onSwappingChange={setSwapping}
      />
    ) : (
      <LiveKitVoiceStageVideo
        track={track.track}
        mediaId={mediaId}
        className={className}
        fit={fit}
        style={style}
        onVideoSizeChange={onVideoSizeChange}
        onSwappingChange={setSwapping}
      />
    )

  return (
    <>
      {video}
      {track.reconnecting || swapping ? <QualitySwitchOverlay /> : null}
    </>
  )
}

/** Shown over the last frame while the stream switches resolution/FPS. */
function QualitySwitchOverlay() {
  const t = useTranslations('voice')

  return (
    <div
      role="status"
      aria-live="polite"
      className="pointer-events-none absolute inset-0 z-1 flex flex-col items-center justify-center gap-2 bg-media-backdrop/50 px-2 text-on-media"
    >
      <Spinner className="size-6 shrink-0" aria-hidden />
      <span className="max-w-full truncate text-xs font-medium">
        {t('stage.videoQualitySwitching')}
      </span>
    </div>
  )
}

function LiveKitVoiceStageVideo({
  track,
  mediaId,
  className,
  fit,
  style,
  onVideoSizeChange,
  onSwappingChange,
}: {
  track: VideoTrack
  mediaId: string
  className?: string
  fit: 'contain' | 'cover'
  style?: CSSProperties
  onVideoSizeChange?: (size: { width: number; height: number }) => void
  onSwappingChange?: (swapping: boolean) => void
}) {
  const hostRef = useRef<HTMLDivElement>(null)
  useReleaseMediaOnUnmount(hostRef)
  const elementRef = useRef<HTMLVideoElement | null>(null)
  const onVideoSizeChangeRef = useRef(onVideoSizeChange)
  onVideoSizeChangeRef.current = onVideoSizeChange
  const onSwappingChangeRef = useRef(onSwappingChange)
  onSwappingChangeRef.current = onSwappingChange
  const trackSid = track.sid ?? mediaId

  useEffect(() => {
    const host = hostRef.current
    if (!host) return

    const doc = host.ownerDocument
    const element = doc.createElement('video')
    element.setAttribute(VOICE_STAGE_MEDIA_ID_ATTR, mediaId)
    element.playsInline = true
    element.autoplay = true
    element.muted = true
    applyMediaElementPresentation(element, className, fit, style)
    const attachedElement = track.attach(element) as HTMLVideoElement
    elementRef.current = attachedElement
    // Keep the previous video visible until this one has a frame (see canvas).
    host.appendChild(attachedElement)
    if (host.children.length > 1) onSwappingChangeRef.current?.(true)
    const retirePrevious = () => {
      retireStaleMediaElements(host, attachedElement)
      onSwappingChangeRef.current?.(false)
    }
    const fallback = setTimeout(retirePrevious, MEDIA_SWAP_FALLBACK_MS)
    const onFirstFrame = () => {
      clearTimeout(fallback)
      retirePrevious()
    }
    attachedElement.addEventListener('loadeddata', onFirstFrame, { once: true })

    const emitSize = () => {
      if (attachedElement.videoWidth > 0 && attachedElement.videoHeight > 0) {
        onVideoSizeChangeRef.current?.({
          width: attachedElement.videoWidth,
          height: attachedElement.videoHeight,
        })
      }
    }

    const onLoadedMetadata = () => {
      emitSize()
    }

    attachedElement.addEventListener('loadedmetadata', onLoadedMetadata)
    attachedElement.addEventListener('resize', emitSize)
    void attachedElement.play().catch(() => {})
    onLoadedMetadata()

    return () => {
      clearTimeout(fallback)
      attachedElement.removeEventListener('loadeddata', onFirstFrame)
      attachedElement.removeEventListener('loadedmetadata', onLoadedMetadata)
      attachedElement.removeEventListener('resize', emitSize)
      track.detach(attachedElement)
      // Detached, it keeps showing its last frame until the next element plays.
      attachedElement.pause()
      elementRef.current = null
    }
  }, [mediaId, track, trackSid])

  useEffect(() => {
    const element = elementRef.current
    if (!element) return

    applyMediaElementPresentation(element, className, fit, style)
  }, [className, fit, style])

  return <div ref={hostRef} className="absolute inset-0 size-full" />
}

function NativeVoiceStageCanvas({
  track,
  mediaId,
  className,
  fit,
  style,
  onVideoSizeChange,
  onSwappingChange,
}: {
  track: NativeVideoTrackAdapter
  mediaId: string
  className?: string
  fit: 'contain' | 'cover'
  style?: CSSProperties
  onVideoSizeChange?: (size: { width: number; height: number }) => void
  onSwappingChange?: (swapping: boolean) => void
}) {
  const hostRef = useRef<HTMLDivElement>(null)
  useReleaseMediaOnUnmount(hostRef)
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const onVideoSizeChangeRef = useRef(onVideoSizeChange)
  onVideoSizeChangeRef.current = onVideoSizeChange
  const onSwappingChangeRef = useRef(onSwappingChange)
  onSwappingChangeRef.current = onSwappingChange

  useEffect(() => {
    const host = hostRef.current
    if (!host) return

    const canvas = host.ownerDocument.createElement('canvas')
    canvas.setAttribute(VOICE_STAGE_MEDIA_ID_ATTR, mediaId)
    applyMediaElementPresentation(canvas, className, fit, style)
    canvasRef.current = canvas
    // The previous canvas keeps its last frame on screen until this one draws:
    // a quality change republishes the stream and must not flash empty.
    host.appendChild(canvas)
    if (host.children.length > 1) onSwappingChangeRef.current?.(true)
    const retirePrevious = () => {
      retireStaleMediaElements(host, canvas)
      onSwappingChangeRef.current?.(false)
    }
    const fallback = setTimeout(retirePrevious, MEDIA_SWAP_FALLBACK_MS)
    let drewFirstFrame = false
    const detach = track.attachCanvas(canvas, (size) => {
      onVideoSizeChangeRef.current?.(size)
    }, {
      fit,
      onFrame: () => {
        if (drewFirstFrame) return
        drewFirstFrame = true
        clearTimeout(fallback)
        retirePrevious()
      },
    })

    return () => {
      clearTimeout(fallback)
      detach()
      canvasRef.current = null
    }
  }, [mediaId, track])

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    applyMediaElementPresentation(canvas, className, fit, style)
  }, [className, fit, style])

  return <div ref={hostRef} className="absolute inset-0 size-full" />
}
