import type { Room } from 'livekit-client'

import type { ScreenShareQualityName } from '#/features/voice/voice-preference-types'
import { screenShareCaptureOptions } from '#/features/voice/voice-capture'
import { getVoicePeerConnectionEntries } from '#/features/voice/voice-ping'

type ScreenShareEncoding = {
  maxBitrate?: number
  maxFramerate?: number
}

function screenShareBitrateFloor(maxBitrate: number) {
  return Math.round(maxBitrate * 0.5)
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
  nextEncoding.minBitrate = screenShareBitrateFloor(maxBitrate)
  if (encoding.maxFramerate != null) {
    nextEncoding.maxFramerate = encoding.maxFramerate
  }

  try {
    await sender.setParameters(params)
  } catch {
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
      await applyScreenShareSenderBitrate(room, mediaStreamTrack, encoding)
      return
    }

    await new Promise<void>((resolve) => {
      window.setTimeout(resolve, 50)
    })
  }
}

export async function tuneScreenShareAfterPublish(
  room: Room,
  mediaStreamTrack: MediaStreamTrack,
  quality: ScreenShareQualityName,
) {
  const capture = screenShareCaptureOptions(quality)
  const resolution = capture.capture.resolution

  await clampScreenShareCaptureResolution(mediaStreamTrack, {
    maxWidth: resolution.width,
    maxHeight: resolution.height,
    frameRate: resolution.frameRate,
  })

  const encoding = capture.publish.screenShareEncoding ?? {}
  await waitForScreenShareSender(room, mediaStreamTrack, encoding)
}
