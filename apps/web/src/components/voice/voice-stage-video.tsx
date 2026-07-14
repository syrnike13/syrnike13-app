import { useEffect, useRef, type CSSProperties } from 'react'
import type { VideoTrack } from 'livekit-client'

import {
  isNativeVideoTrackAdapter,
  type NativeVideoTrackAdapter,
} from '#/features/voice/native-video-registry'
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
  if (isNativeVideoTrackAdapter(track)) {
    return (
      <NativeVoiceStageCanvas
        track={track}
        mediaId={mediaId}
        className={className}
        fit={fit}
        style={style}
        onVideoSizeChange={onVideoSizeChange}
      />
    )
  }

  return (
    <LiveKitVoiceStageVideo
      track={track}
      mediaId={mediaId}
      className={className}
      fit={fit}
      style={style}
      onVideoSizeChange={onVideoSizeChange}
    />
  )
}

function LiveKitVoiceStageVideo({
  track,
  mediaId,
  className,
  fit,
  style,
  onVideoSizeChange,
}: {
  track: VideoTrack
  mediaId: string
  className?: string
  fit: 'contain' | 'cover'
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
    element.setAttribute(VOICE_STAGE_MEDIA_ID_ATTR, mediaId)
    element.playsInline = true
    element.autoplay = true
    element.muted = true
    applyMediaElementPresentation(element, className, fit, style)
    const attachedElement = track.attach(element) as HTMLVideoElement
    elementRef.current = attachedElement
    host.replaceChildren(attachedElement)

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
      attachedElement.removeEventListener('loadedmetadata', onLoadedMetadata)
      attachedElement.removeEventListener('resize', emitSize)
      track.detach(attachedElement)
      if (attachedElement.parentElement === host) {
        host.replaceChildren()
      }
      attachedElement.pause()
      attachedElement.srcObject = null
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
}: {
  track: NativeVideoTrackAdapter
  mediaId: string
  className?: string
  fit: 'contain' | 'cover'
  style?: CSSProperties
  onVideoSizeChange?: (size: { width: number; height: number }) => void
}) {
  const hostRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const onVideoSizeChangeRef = useRef(onVideoSizeChange)
  onVideoSizeChangeRef.current = onVideoSizeChange

  useEffect(() => {
    const host = hostRef.current
    if (!host) return

    const canvas = host.ownerDocument.createElement('canvas')
    canvas.setAttribute(VOICE_STAGE_MEDIA_ID_ATTR, mediaId)
    applyMediaElementPresentation(canvas, className, fit, style)
    canvasRef.current = canvas
    host.replaceChildren(canvas)
    const detach = track.attachCanvas(canvas, (size) => {
      onVideoSizeChangeRef.current?.(size)
    })

    return () => {
      detach()
      if (canvas.parentElement === host) host.replaceChildren()
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
