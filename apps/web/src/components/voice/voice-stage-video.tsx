import { useEffect, useRef, type CSSProperties } from 'react'
import type { VideoTrack } from 'livekit-client'

import { cn } from '#/lib/utils'

export const VOICE_STAGE_MEDIA_ID_ATTR = 'data-voice-stage-media-id'

function applyVideoElementPresentation(
  element: HTMLVideoElement,
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

function createVideoStream(
  doc: Document,
  mediaStreamTrack: MediaStreamTrack,
) {
  const MediaStreamConstructor =
    typeof doc.defaultView?.MediaStream === 'function'
      ? doc.defaultView.MediaStream
      : window.MediaStream
  return new MediaStreamConstructor([mediaStreamTrack])
}

export function VoiceStageVideo({
  track,
  mediaId,
  className,
  fit = 'cover',
  style,
  onVideoSizeChange,
}: {
  track: VideoTrack
  mediaId: string
  className?: string
  fit?: 'contain' | 'cover'
  style?: CSSProperties
  onVideoSizeChange?: (size: { width: number; height: number }) => void
}) {
  const hostRef = useRef<HTMLDivElement>(null)
  const elementRef = useRef<HTMLVideoElement | null>(null)
  const onVideoSizeChangeRef = useRef(onVideoSizeChange)
  onVideoSizeChangeRef.current = onVideoSizeChange
  const trackSid = track.sid ?? mediaId

  useEffect(() => {
    const host = hostRef.current
    if (!host) return

    const doc = host.ownerDocument
    const element = doc.createElement('video')
    elementRef.current = element
    element.setAttribute(VOICE_STAGE_MEDIA_ID_ATTR, mediaId)
    element.playsInline = true
    element.autoplay = true
    element.muted = true
    element.srcObject = createVideoStream(doc, track.mediaStreamTrack)
    applyVideoElementPresentation(element, className, fit, style)
    host.replaceChildren(element)

    const emitSize = () => {
      if (element.videoWidth > 0 && element.videoHeight > 0) {
        onVideoSizeChangeRef.current?.({
          width: element.videoWidth,
          height: element.videoHeight,
        })
      }
    }

    const onLoadedMetadata = () => {
      emitSize()
    }

    element.addEventListener('loadedmetadata', onLoadedMetadata)
    element.addEventListener('resize', emitSize)
    void element.play().catch(() => {})
    onLoadedMetadata()

    return () => {
      element.removeEventListener('loadedmetadata', onLoadedMetadata)
      element.removeEventListener('resize', emitSize)
      if (element.parentElement === host) {
        host.replaceChildren()
      }
      element.pause()
      element.srcObject = null
      elementRef.current = null
    }
  }, [className, fit, mediaId, style, track.mediaStreamTrack, trackSid])

  useEffect(() => {
    const element = elementRef.current
    if (!element) return

    applyVideoElementPresentation(element, className, fit, style)
  }, [className, fit, style])

  return <div ref={hostRef} className="absolute inset-0 size-full" />
}
