import type { Translator } from '@syrnike13/ui/i18n'

import type { VoiceStageMediaTrack } from './voice-context'

export const STREAM_PREVIEW_FIRST_DELAY_MS = 3_000
export const STREAM_PREVIEW_INTERVAL_MS = 120_000
export const STREAM_PREVIEW_FRAME_TIMEOUT_MS = 5_000

function encodePreview(canvas: HTMLCanvasElement, type: string) {
  return new Promise<Blob | null>((resolve) =>
    canvas.toBlob(resolve, type, 0.8),
  )
}

/** Own the decoder/canvas consumer only for one bounded capture attempt. */
export async function captureStreamPreview(
  track: VoiceStageMediaTrack,
  signal: AbortSignal,
): Promise<Blob> {
  signal.throwIfAborted()
  const source = document.createElement('canvas')
  const canvas = document.createElement('canvas')
  const video =
    track.backend === 'livekit' ? document.createElement('video') : null
  let detach: (() => void) | undefined
  let frameCallback: number | undefined
  let timeout: ReturnType<typeof setTimeout> | undefined
  let cancel = () => {}
  let ready = () => {}
  try {
    await new Promise<void>((resolve, reject) => {
      ready = () => {
        clearTimeout(timeout)
        resolve()
      }
      cancel = () => reject(signal.reason)
      signal.addEventListener('abort', cancel, { once: true })
      timeout = setTimeout(
        () =>
          reject(new Error('Stream preview first frame timed out after 5 s')),
        STREAM_PREVIEW_FRAME_TIMEOUT_MS,
      )
      if (track.backend === 'native') {
        detach = track.track.attachCanvas(source, undefined, {
          backingSize: { width: 480, height: 270 },
          onFrame: ready,
        })
      } else if (video) {
        const localTrack = track.track
        video.muted = true
        video.playsInline = true
        const loaded = () => {
          if (video.readyState >= 2 && video.videoWidth && video.videoHeight)
            ready()
        }
        detach = () => {
          if (frameCallback !== undefined)
            video.cancelVideoFrameCallback(frameCallback)
          video.removeEventListener('loadeddata', loaded)
          localTrack.detach(video)
          video.pause()
          video.srcObject = null
        }
        if (typeof video.requestVideoFrameCallback === 'function') {
          frameCallback = video.requestVideoFrameCallback(ready)
        } else {
          video.addEventListener('loadeddata', loaded)
        }
        localTrack.attach(video)
        void video.play().catch(reject)
      }
    })
    signal.throwIfAborted()
    const dimensions = streamPreviewDimensions(
      video ? video.videoWidth : source.width,
      video ? video.videoHeight : source.height,
    )
    canvas.width = dimensions.width
    canvas.height = dimensions.height
    const context = canvas.getContext('2d')
    if (!context) throw new Error('Stream preview canvas context unavailable')
    context.drawImage(video ?? source, 0, 0, canvas.width, canvas.height)
    detach?.()
    detach = undefined
    let image = await encodePreview(canvas, 'image/webp')
    if (!image || image.type !== 'image/webp')
      image = await encodePreview(canvas, 'image/jpeg')
    if (
      !image ||
      (image.type !== 'image/webp' && image.type !== 'image/jpeg')
    ) {
      throw new Error('Stream preview encoding unavailable')
    }
    if (image.size > 256 * 1024)
      throw new Error('Stream preview exceeds 256 KiB')
    return image
  } finally {
    clearTimeout(timeout)
    signal.removeEventListener('abort', cancel)
    detach?.()
    source.width = source.height = 0
    canvas.width = canvas.height = 0
  }
}

export function streamPreviewDimensions(width: number, height: number) {
  const scale = Math.min(1, 480 / width, 270 / height)
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  }
}

/** Starts when the local screen track is available; captures never overlap or retry early. */
export function scheduleStreamPreview(
  capture: () => Promise<void>,
  onError: (error: unknown) => void,
) {
  let stopped = false
  let started = false
  let timer: ReturnType<typeof setTimeout> | undefined
  const run = async () => {
    try {
      await capture()
    } catch (error) {
      if (!stopped) onError(error)
    }
    if (!stopped)
      timer = setTimeout(() => {
        void run()
      }, STREAM_PREVIEW_INTERVAL_MS)
  }
  return {
    start() {
      if (started || stopped) return
      started = true
      timer = setTimeout(() => {
        void run()
      }, STREAM_PREVIEW_FIRST_DELAY_MS)
    },
    stop() {
      stopped = true
      clearTimeout(timer)
    },
  }
}

export function streamPreviewWatchLabel(
  self: boolean,
  watching: boolean,
  t: Translator,
) {
  return self
    ? t('stream.self')
    : watching
      ? t('stream.watching')
      : t('stream.watch')
}
