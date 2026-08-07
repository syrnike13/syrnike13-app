import type { Room } from 'livekit-client'
import { Effect, Schedule, Schema } from 'effect'

import type { ScreenShareQualityName } from '#/features/voice/voice-preference-types'
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

class ScreenShareSenderUnavailable extends Schema.TaggedErrorClass<ScreenShareSenderUnavailable>()(
  'ScreenShareSenderUnavailable',
  {},
) {}

const clampScreenShareCaptureResolutionEffect = Effect.fn(
  'screenShare.clampCaptureResolution',
)(function*(
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

  yield* Effect.tryPromise({
    try: () => track.applyConstraints(constraints),
    catch: (cause) => cause,
  }).pipe(Effect.catch(() => Effect.void))
})

export function clampScreenShareCaptureResolution(
  track: MediaStreamTrack,
  limits: {
    maxWidth: number
    maxHeight: number
    frameRate?: number
  },
) {
  return Effect.runPromise(
    clampScreenShareCaptureResolutionEffect(track, limits),
  )
}

const applyScreenShareSenderBitrate = Effect.fn(
  'screenShare.applySenderBitrate',
)(function*(
  room: Room,
  mediaStreamTrack: MediaStreamTrack,
  encoding: ScreenShareEncoding,
) {
  const maxBitrate = encoding.maxBitrate
  if (maxBitrate == null) return

  const publisher = getVoicePeerConnectionEntries(room).find(
    (entry) => entry.role === 'publisher',
  )
  const senders = publisher?.pc.getSenders?.()
  if (!senders) return

  const sender = senders.find(
    (candidate) => candidate.track?.id === mediaStreamTrack.id,
  )
  if (!sender) return

  const params = sender.getParameters()
  if (!params.encodings?.length) {
    params.encodings = [{}]
  }

  const nextEncoding = params.encodings[0]
  nextEncoding.maxBitrate = maxBitrate
  Reflect.set(
    nextEncoding,
    'minBitrate',
    screenShareBitrateFloor(maxBitrate),
  )
  if (encoding.maxFramerate != null) {
    nextEncoding.maxFramerate = encoding.maxFramerate
  }

  yield* Effect.tryPromise({
    try: () => sender.setParameters(params),
    catch: (cause) => cause,
  }).pipe(Effect.catch(() => Effect.void))
})

const waitForScreenShareSender = Effect.fn(
  'screenShare.waitForSender',
)(function*(
  room: Room,
  mediaStreamTrack: MediaStreamTrack,
  encoding: ScreenShareEncoding,
) {
  const findAndApply = Effect.gen(function*() {
    const publisher = getVoicePeerConnectionEntries(room).find(
      (entry) => entry.role === 'publisher',
    )
    const sender = publisher?.pc
      .getSenders?.()
      .find((candidate) => candidate.track?.id === mediaStreamTrack.id)

    if (!sender) {
      return yield* Effect.fail(new ScreenShareSenderUnavailable())
    }

    yield* applyScreenShareSenderBitrate(room, mediaStreamTrack, encoding)
  })

  yield* findAndApply.pipe(
    Effect.retry({
      times: 4,
      schedule: Schedule.spaced(50),
    }),
    Effect.catch(() => Effect.void),
  )
})

const tuneScreenShareAfterPublishEffect = Effect.fn(
  'screenShare.tuneAfterPublish',
)(function*(
  room: Room,
  mediaStreamTrack: MediaStreamTrack,
  quality: ScreenShareQualityName,
  limits?: ScreenShareCaptureLimits,
) {
  const capture = screenShareCaptureOptions(quality, limits)
  const resolution = capture.capture.resolution

  yield* clampScreenShareCaptureResolutionEffect(mediaStreamTrack, {
    maxWidth: resolution.width,
    maxHeight: resolution.height,
    frameRate: resolution.frameRate,
  })

  const encoding = capture.publish.screenShareEncoding ?? {}
  yield* waitForScreenShareSender(room, mediaStreamTrack, encoding)
})

export function tuneScreenShareAfterPublish(
  room: Room,
  mediaStreamTrack: MediaStreamTrack,
  quality: ScreenShareQualityName,
  limits?: ScreenShareCaptureLimits,
) {
  return Effect.runPromise(
    tuneScreenShareAfterPublishEffect(
      room,
      mediaStreamTrack,
      quality,
      limits,
    ),
  )
}
