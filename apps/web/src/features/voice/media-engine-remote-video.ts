import type { StageMediaTrackSource } from '#/features/voice/voice-stage-media'
import { engineStageVideoKey } from '#/features/voice/engine-stage-video'

export type MediaEngineRemoteVideoFrame = {
  jpegDataUrl: string
  width: number
  height: number
}

const frames = new Map<string, MediaEngineRemoteVideoFrame>()
const listeners = new Set<() => void>()

function notify() {
  for (const listener of listeners) {
    listener()
  }
}

export function subscribeMediaEngineRemoteVideo(listener: () => void) {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

export function getMediaEngineRemoteVideoSnapshot() {
  return frames
}

export function hasMediaEngineRemoteVideoFrame(
  userId: string,
  source: StageMediaTrackSource,
) {
  return frames.has(engineStageVideoKey(userId, source))
}

export function getMediaEngineRemoteVideoFrame(
  userId: string,
  source: StageMediaTrackSource,
) {
  return frames.get(engineStageVideoKey(userId, source)) ?? null
}

export function updateMediaEngineRemoteVideoFrame(
  userId: string,
  source: StageMediaTrackSource,
  jpegBase64: string,
  width: number,
  height: number,
) {
  frames.set(engineStageVideoKey(userId, source), {
    jpegDataUrl: `data:image/jpeg;base64,${jpegBase64}`,
    width,
    height,
  })
  notify()
}

export function clearMediaEngineRemoteVideo(
  userId?: string,
  source?: StageMediaTrackSource,
) {
  if (userId && source) {
    frames.delete(engineStageVideoKey(userId, source))
    notify()
    return
  }

  if (userId) {
    for (const key of frames.keys()) {
      if (key.startsWith(`${userId}:`)) {
        frames.delete(key)
      }
    }
    notify()
    return
  }

  frames.clear()
  notify()
}

export function disposeMediaEngineRemoteVideo() {
  clearMediaEngineRemoteVideo()
}
