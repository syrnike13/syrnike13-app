import type { Room } from 'livekit-client'

import type { ScreenShareQualityName } from '#/features/voice/voice-preference-types'
import { logVoiceDebugAgent } from '#/features/voice/voice-debug-agent-log'
import {
  screenShareCaptureOptions,
  type ScreenShareCaptureLimits,
} from '#/features/voice/voice-capture'
import { getVoicePeerConnectionEntries } from '#/features/voice/voice-ping'

type ScreenShareEncoding = {
  maxBitrate?: number
  maxFramerate?: number
}

function screenShareBitrateFloor(maxBitrate: number) {
  return maxBitrate
}

export async function clampScreenShareCaptureResolution(
  track: MediaStreamTrack,
  limits: {
    maxWidth: number
    maxHeight: number
    frameRate?: number
  },
) {
  const settings = track.getSettings()
  const width = settings.width ?? 0
  const height = settings.height ?? 0
  const exceedsResolution =
    width > limits.maxWidth || height > limits.maxHeight

  const constraints: MediaTrackConstraints = {}
  if (exceedsResolution) {
    constraints.width = { ideal: limits.maxWidth, max: limits.maxWidth }
    constraints.height = { ideal: limits.maxHeight, max: limits.maxHeight }
  }
  if (limits.frameRate != null) {
    constraints.frameRate = {
      ideal: limits.frameRate,
      max: limits.frameRate,
    }
  }

  if (Object.keys(constraints).length === 0) return

  try {
    await track.applyConstraints(constraints)
  } catch {
    // Best effort: Chromium may ignore downscale on some capture paths.
  }
}

async function applyScreenShareSenderBitrate(
  room: Room,
  mediaStreamTrack: MediaStreamTrack,
  encoding: ScreenShareEncoding,
) {
  const maxBitrate = encoding.maxBitrate
  if (maxBitrate == null) return

  const publisher = getVoicePeerConnectionEntries(room).find(
    (entry) => entry.role === 'publisher',
  )
  if (!publisher) return

  const sender = publisher.pc
    .getSenders()
    .find((candidate) => candidate.track?.id === mediaStreamTrack.id)
  if (!sender) return

  const params = sender.getParameters()
  if (!params.encodings?.length) {
    params.encodings = [{}]
  }

  const nextEncoding = params.encodings[0]
  nextEncoding.maxBitrate = maxBitrate
  ;(nextEncoding as RTCRtpEncodingParameters & { minBitrate?: number }).minBitrate =
    screenShareBitrateFloor(maxBitrate)
  if (encoding.maxFramerate != null) {
    nextEncoding.maxFramerate = encoding.maxFramerate
  }

  try {
    await sender.setParameters(params)
    logVoiceDebugAgent({
      hypothesis: 'H5-browser-sender-tuning-miss',
      event: 'browser-screen-sender-tuned',
      maxBitrate,
      minBitrate: screenShareBitrateFloor(maxBitrate),
      maxFramerate: encoding.maxFramerate,
      trackSettings: mediaStreamTrack.getSettings(),
    })
  } catch {
    logVoiceDebugAgent({
      hypothesis: 'H5-browser-sender-tuning-miss',
      event: 'browser-screen-sender-tune-failed',
      maxBitrate,
      maxFramerate: encoding.maxFramerate,
      trackSettings: mediaStreamTrack.getSettings(),
    })
    // Sender may not be negotiated yet; caller can retry briefly.
  }
}

async function waitForScreenShareSender(
  room: Room,
  mediaStreamTrack: MediaStreamTrack,
  encoding: ScreenShareEncoding,
) {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const publisher = getVoicePeerConnectionEntries(room).find(
      (entry) => entry.role === 'publisher',
    )
    const sender = publisher?.pc
      .getSenders()
      .find((candidate) => candidate.track?.id === mediaStreamTrack.id)

    if (sender) {
      logVoiceDebugAgent({
        hypothesis: 'H5-browser-sender-tuning-miss',
        event: 'browser-screen-sender-found',
        attempt,
      })
      await applyScreenShareSenderBitrate(room, mediaStreamTrack, encoding)
      return
    }

    await new Promise<void>((resolve) => {
      window.setTimeout(resolve, 50)
    })
  }
  logVoiceDebugAgent({
    hypothesis: 'H5-browser-sender-tuning-miss',
    event: 'browser-screen-sender-missed',
    attempts: 5,
    trackSettings: mediaStreamTrack.getSettings(),
  })
}

export async function tuneScreenShareAfterPublish(
  room: Room,
  mediaStreamTrack: MediaStreamTrack,
  quality: ScreenShareQualityName,
  limits?: ScreenShareCaptureLimits,
) {
  const capture = screenShareCaptureOptions(quality, limits)
  const resolution = capture.capture.resolution

  await clampScreenShareCaptureResolution(mediaStreamTrack, {
    maxWidth: resolution.width,
    maxHeight: resolution.height,
    frameRate: resolution.frameRate,
  })

  const encoding = capture.publish.screenShareEncoding ?? {}
  await waitForScreenShareSender(room, mediaStreamTrack, encoding)
}
