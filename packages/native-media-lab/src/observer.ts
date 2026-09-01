import {
  AudioStream,
  ContinualGatheringPolicy,
  dispose,
  IceTransportType,
  Room,
  RoomEvent,
  TrackKind,
  VideoStream,
  type RemoteTrack,
} from '@livekit/rtc-node'
import { Effect, Schema } from 'effect'
import { writeFile } from 'node:fs/promises'
import {
  decodeVideoMarker,
  sampleVideoContentHash,
  videoMarkerLatency,
} from './marker.js'

const ObserverEnvironment = Schema.Struct({
  LIVEKIT_URL: Schema.String,
  LIVEKIT_OBSERVER_TOKEN: Schema.String,
  MEDIA_LAB_REPORT_PATH: Schema.String,
  MEDIA_LAB_READY_PATH: Schema.String,
  MEDIA_LAB_MIN_VIDEO_FRAMES: Schema.optional(Schema.String),
  MEDIA_LAB_MIN_AUDIO_PULSES: Schema.optional(Schema.String),
  MEDIA_LAB_TIMEOUT_MS: Schema.optional(Schema.String),
  MEDIA_LAB_OBSERVER_DELAY_MS: Schema.optional(Schema.String),
  MEDIA_LAB_SUBSCRIBE_DELAY_MS: Schema.optional(Schema.String),
  MEDIA_LAB_ALLOW_VIDEO_GAPS: Schema.optional(Schema.String),
  MEDIA_LAB_EXPECT_SUBSCRIPTIONS: Schema.optional(Schema.String),
  MEDIA_LAB_MAX_VIDEO_LATENCY_MS: Schema.optional(Schema.String),
  MEDIA_LAB_MAX_FRAME_AGE_MS: Schema.optional(Schema.String),
  MEDIA_LAB_EXPECT_VIDEO_END: Schema.optional(Schema.String),
  MEDIA_LAB_MIN_AUDIO_FRAMES_AFTER_VIDEO_END: Schema.optional(Schema.String),
  MEDIA_LAB_ICE_TRANSPORT: Schema.optional(
    Schema.Union([Schema.Literal('all'), Schema.Literal('nohost')]),
  ),
})

interface ObserverOptions {
  readonly url: string
  readonly token: string
  readonly reportPath: string
  readonly readyPath: string
  readonly minimumVideoFrames: number
  readonly minimumAudioPulses: number
  readonly timeoutMs: number
  readonly delayMs: number
  readonly subscribeDelayMs: number
  readonly allowVideoGaps: boolean
  readonly expectedSubscriptions: number
  readonly maximumVideoLatencyMs: number
  readonly maximumFrameAgeMs: number
  readonly expectVideoEnd: boolean
  readonly minimumAudioFramesAfterVideoEnd: number
  readonly iceTransportType: IceTransportType
}

interface VerificationReport {
  readonly schemaVersion: 1
  readonly accepted: boolean
  readonly startedAt: string
  readonly finishedAt: string
  readonly durationMs: number
  readonly video: {
    readonly receivedFrames: number
    readonly decodedFrames: number
    readonly maximumConsecutiveFrames: number
    readonly sequenceGaps: number
    readonly outOfOrderFrames: number
    readonly duplicateFrames: number
    readonly minimumLatencyMs: number | null
    readonly maximumLatencyMs: number | null
    readonly averageLatencyMs: number | null
    readonly invalidTimestampFrames: number
    readonly observerDroppedFrames: number
    readonly maximumObserverBacklogFrames: number
    readonly firstSequence: number | null
    readonly lastSequence: number | null
    readonly p50LatencyMs: number | null
    readonly p95LatencyMs: number | null
    readonly staleFrames: number
    readonly resolutionTransitions: number
    readonly resolutions: readonly {
      readonly generation: number
      readonly width: number
      readonly height: number
    }[]
    readonly maximumNoFrameDurationMs: number
    readonly contentChanges: number
    readonly endReason: string
  }
  readonly audio: {
    readonly receivedFrames: number
    readonly receivedSamples: number
    readonly controlPulses: number
    readonly discontinuities: number
    readonly framesAfterVideoEnd: number
  }
  readonly tracks: {
    readonly subscribed: number
    readonly unsubscribed: number
  }
  readonly failures: readonly string[]
}

class ObserverFailure extends Error {
  readonly _tag = 'ObserverFailure'
}

function integerOption(value: string | undefined, fallback: number, name: string): number {
  if (value === undefined) return fallback
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new ObserverFailure(`${name} must be a non-negative integer`)
  }
  return parsed
}

function booleanOption(value: string | undefined, fallback: boolean, name: string): boolean {
  if (value === undefined) return fallback
  if (value === 'true') return true
  if (value === 'false') return false
  throw new ObserverFailure(`${name} must be true or false`)
}

function optionsFromEnvironment(): ObserverOptions {
  const decoded = Schema.decodeUnknownResult(ObserverEnvironment)(process.env)
  if (decoded._tag === 'Failure') {
    throw new ObserverFailure(`Invalid observer environment: ${decoded.failure}`)
  }
  const env = decoded.success
  return {
    url: env.LIVEKIT_URL,
    token: env.LIVEKIT_OBSERVER_TOKEN,
    reportPath: env.MEDIA_LAB_REPORT_PATH,
    readyPath: env.MEDIA_LAB_READY_PATH,
    minimumVideoFrames: integerOption(
      env.MEDIA_LAB_MIN_VIDEO_FRAMES,
      600,
      'MEDIA_LAB_MIN_VIDEO_FRAMES',
    ),
    minimumAudioPulses: integerOption(
      env.MEDIA_LAB_MIN_AUDIO_PULSES,
      10,
      'MEDIA_LAB_MIN_AUDIO_PULSES',
    ),
    timeoutMs: integerOption(env.MEDIA_LAB_TIMEOUT_MS, 45_000, 'MEDIA_LAB_TIMEOUT_MS'),
    delayMs: integerOption(env.MEDIA_LAB_OBSERVER_DELAY_MS, 0, 'MEDIA_LAB_OBSERVER_DELAY_MS'),
    subscribeDelayMs: integerOption(
      env.MEDIA_LAB_SUBSCRIBE_DELAY_MS,
      0,
      'MEDIA_LAB_SUBSCRIBE_DELAY_MS',
    ),
    allowVideoGaps: booleanOption(
      env.MEDIA_LAB_ALLOW_VIDEO_GAPS,
      false,
      'MEDIA_LAB_ALLOW_VIDEO_GAPS',
    ),
    expectedSubscriptions: integerOption(
      env.MEDIA_LAB_EXPECT_SUBSCRIPTIONS,
      2,
      'MEDIA_LAB_EXPECT_SUBSCRIPTIONS',
    ),
    maximumVideoLatencyMs: integerOption(
      env.MEDIA_LAB_MAX_VIDEO_LATENCY_MS,
      2_000,
      'MEDIA_LAB_MAX_VIDEO_LATENCY_MS',
    ),
    maximumFrameAgeMs: integerOption(
      env.MEDIA_LAB_MAX_FRAME_AGE_MS,
      2_000,
      'MEDIA_LAB_MAX_FRAME_AGE_MS',
    ),
    expectVideoEnd: booleanOption(
      env.MEDIA_LAB_EXPECT_VIDEO_END,
      false,
      'MEDIA_LAB_EXPECT_VIDEO_END',
    ),
    minimumAudioFramesAfterVideoEnd: integerOption(
      env.MEDIA_LAB_MIN_AUDIO_FRAMES_AFTER_VIDEO_END,
      0,
      'MEDIA_LAB_MIN_AUDIO_FRAMES_AFTER_VIDEO_END',
    ),
    iceTransportType: env.MEDIA_LAB_ICE_TRANSPORT === 'nohost'
      ? IceTransportType.TRANSPORT_NOHOST
      : IceTransportType.TRANSPORT_ALL,
  }
}

async function observe(room: Room, options: ObserverOptions): Promise<VerificationReport> {
  const startedAtMs = Date.now()
  const failures: string[] = []
  const videoLatencies: number[] = []
  let videoReceived = 0
  let videoDecoded = 0
  let invalidVideoTimestamps = 0
  let maximumConsecutiveFrames = 0
  let sequenceGaps = 0
  let outOfOrderFrames = 0
  let duplicateFrames = 0
  let observerDroppedFrames = 0
  let maximumObserverBacklogFrames = 0
  let reportLastVideoSequence: number | undefined
  let firstVideoSequence: number | undefined
  let staleVideoFrames = 0
  let resolutionTransitions = 0
  const resolutions: Array<{ generation: number; width: number; height: number }> = []
  let lastResolution: { generation: number; width: number; height: number } | undefined
  let lastVideoFrameAt: number | undefined
  let maximumNoFrameDurationMs = 0
  let lastContentHash: number | undefined
  let contentChanges = 0
  let videoEndReason: string | undefined
  let videoEndedAt: number | undefined
  let audioFrames = 0
  let audioSamples = 0
  let audioPulses = 0
  let audioDiscontinuities = 0
  let audioFramesAfterVideoEnd = 0
  let lastAudioFrameAt: number | undefined
  let pulseActive = false
  let lastPulseAt = 0
  let tracksSubscribed = 0
  let tracksUnsubscribed = 0
  const streamTasks = new Set<Promise<void>>()
  const cancelVideoStreams = new Map<RemoteTrack, () => Promise<void>>()
  const subscriptionTimers = new Set<NodeJS.Timeout>()

  let resolveAccepted: (() => void) | undefined
  let rejectAccepted: ((error: Error) => void) | undefined
  const accepted = new Promise<void>((resolve, reject) => {
    resolveAccepted = resolve
    rejectAccepted = reject
  })

  const checkAcceptance = () => {
    const videoAccepted = options.allowVideoGaps
      ? videoDecoded >= options.minimumVideoFrames
      : maximumConsecutiveFrames >= options.minimumVideoFrames
    if (
      videoAccepted &&
      videoLatencies.length === videoDecoded &&
      outOfOrderFrames === 0 &&
      staleVideoFrames === 0 &&
      audioPulses >= options.minimumAudioPulses &&
      tracksSubscribed >= options.expectedSubscriptions &&
      (!options.expectVideoEnd || videoEndReason !== undefined) &&
      audioFramesAfterVideoEnd >= options.minimumAudioFramesAfterVideoEnd
    ) resolveAccepted?.()
  }

  const consumeVideo = async (track: RemoteTrack) => {
    const reader = new VideoStream(track).getReader()
    cancelVideoStreams.set(track, async () => {
      try {
        await reader.cancel('track unpublished')
      } catch {
        // EOS and cancellation can race; either path has already stopped delivery.
      }
    })
    let streamLastSequence: number | undefined
    let streamConsecutiveFrames = 0
    type VideoValue = NonNullable<Awaited<ReturnType<typeof reader.read>>['value']>
    const processValue = (value: VideoValue) => {
      const receivedAt = Date.now()
      if (lastVideoFrameAt !== undefined) {
        maximumNoFrameDurationMs = Math.max(
          maximumNoFrameDurationMs,
          receivedAt - lastVideoFrameAt,
        )
      }
      lastVideoFrameAt = receivedAt
      const marker = decodeVideoMarker(value.frame)
      if (marker !== undefined) {
        videoDecoded += 1
        firstVideoSequence ??= marker.sequence
        const latency = videoMarkerLatency(
          marker.capturedAtMs,
          receivedAt,
          options.timeoutMs,
        )
        if (latency !== undefined) {
          videoLatencies.push(latency)
          if (latency > options.maximumFrameAgeMs) staleVideoFrames += 1
        } else {
          invalidVideoTimestamps += 1
        }
        if (
          streamLastSequence === undefined ||
          marker.sequence === streamLastSequence + 1
        ) {
          streamConsecutiveFrames += 1
        } else if (marker.sequence < streamLastSequence) {
          outOfOrderFrames += 1
          streamConsecutiveFrames = 1
        } else if (marker.sequence === streamLastSequence) {
          duplicateFrames += 1
        } else {
          const gap = marker.sequence - streamLastSequence - 1
          sequenceGaps += gap
          observerDroppedFrames += gap
          streamConsecutiveFrames = 1
        }
        streamLastSequence = marker.sequence
        reportLastVideoSequence = marker.sequence
        const resolution = {
          generation: marker.generation,
          width: marker.sourceWidth,
          height: marker.sourceHeight,
        }
        if (
          lastResolution === undefined ||
          lastResolution.generation !== resolution.generation ||
          lastResolution.width !== resolution.width ||
          lastResolution.height !== resolution.height
        ) {
          if (lastResolution !== undefined) resolutionTransitions += 1
          if (resolutions.length < 64) resolutions.push(resolution)
          lastResolution = resolution
        }
        const contentHash = sampleVideoContentHash(value.frame)
        if (lastContentHash !== undefined && lastContentHash !== contentHash) {
          contentChanges += 1
        }
        lastContentHash = contentHash
        maximumConsecutiveFrames = Math.max(
          maximumConsecutiveFrames,
          streamConsecutiveFrames,
        )
      }
      checkAcceptance()
    }

    if (options.delayMs === 0) {
      try {
        while (true) {
          const result = await reader.read()
          if (result.done) break
          videoReceived += 1
          processValue(result.value)
        }
      } finally {
        cancelVideoStreams.delete(track)
        reader.releaseLock()
      }
      return
    }

    let pending: VideoValue | undefined
    let readingDone = false
    let wake: (() => void) | undefined
    const pump = (async () => {
      while (true) {
        const result = await reader.read()
        if (result.done) break
        videoReceived += 1
        if (pending !== undefined) observerDroppedFrames += 1
        pending = result.value
        maximumObserverBacklogFrames = 1
        wake?.()
        wake = undefined
      }
      readingDone = true
      wake?.()
    })()
    try {
      while (!readingDone || pending !== undefined) {
        if (pending === undefined) {
          await new Promise<void>((resolve) => {
            if (pending !== undefined || readingDone) resolve()
            else wake = resolve
          })
          continue
        }
        const value = pending
        pending = undefined
        await new Promise<void>((resolve) => setTimeout(resolve, options.delayMs))
        processValue(value)
      }
    } finally {
      await pump
      cancelVideoStreams.delete(track)
      reader.releaseLock()
    }
  }

  const consumeAudio = async (track: RemoteTrack) => {
    const reader = new AudioStream(track, {
      sampleRate: 48_000,
      numChannels: 1,
      frameSizeMs: 10,
    }).getReader()
    try {
      while (true) {
        const result = await reader.read()
        if (result.done) break
        const receivedAt = Date.now()
        if (lastAudioFrameAt !== undefined && receivedAt - lastAudioFrameAt > 100) {
          audioDiscontinuities += 1
        }
        lastAudioFrameAt = receivedAt
        audioFrames += 1
        if (videoEndedAt !== undefined && receivedAt >= videoEndedAt) {
          audioFramesAfterVideoEnd += 1
        }
        audioSamples += result.value.samplesPerChannel
        let maximumAmplitude = 0
        for (const sample of result.value.data) {
          maximumAmplitude = Math.max(maximumAmplitude, Math.abs(sample))
        }
        if (!pulseActive && maximumAmplitude >= 8_000 && receivedAt - lastPulseAt >= 500) {
          pulseActive = true
          lastPulseAt = receivedAt
          audioPulses += 1
        } else if (pulseActive && maximumAmplitude < 4_000) {
          pulseActive = false
        }
        checkAcceptance()
      }
    } finally {
      reader.releaseLock()
    }
  }

  const startStream = (task: Promise<void>) => {
    streamTasks.add(task)
    task.catch((error: unknown) => {
      rejectAccepted?.(normalizeError(error))
    }).finally(() => streamTasks.delete(task))
  }

  room.on(RoomEvent.TrackSubscribed, (track, _publication, participant) => {
    if (participant.identity !== 'native-v2-publisher') return
    tracksSubscribed += 1
    if (track.kind === TrackKind.KIND_VIDEO) {
      videoEndReason = undefined
      videoEndedAt = undefined
      audioFramesAfterVideoEnd = 0
      startStream(consumeVideo(track))
    }
    if (track.kind === TrackKind.KIND_AUDIO) startStream(consumeAudio(track))
  })
  room.on(RoomEvent.TrackUnsubscribed, (_track, _publication, participant) => {
    if (participant.identity !== 'native-v2-publisher') return
    tracksUnsubscribed += 1
    if (_track.kind === TrackKind.KIND_VIDEO) {
      void cancelVideoStreams.get(_track)?.()
      videoEndReason ??= 'track-unpublished'
      videoEndedAt ??= Date.now()
      checkAcceptance()
    }
  })
  room.on(RoomEvent.Disconnected, () => {
    videoEndReason ??= 'room-disconnected'
    videoEndedAt ??= Date.now()
    checkAcceptance()
  })
  if (options.subscribeDelayMs > 0) {
    room.on(RoomEvent.TrackPublished, (publication, participant) => {
      if (participant.identity !== 'native-v2-publisher') return
      const timer = setTimeout(() => {
        subscriptionTimers.delete(timer)
        try {
          publication.setSubscribed(true)
        } catch {
          // A deliberately late subscription may race publication teardown.
        }
      }, options.subscribeDelayMs)
      subscriptionTimers.add(timer)
    })
  }

  await room.connect(options.url, options.token, {
    autoSubscribe: options.subscribeDelayMs === 0,
    dynacast: false,
    rtcConfig: {
      iceTransportType: options.iceTransportType,
      continualGatheringPolicy:
        ContinualGatheringPolicy.GATHER_CONTINUALLY,
      iceServers: [],
    },
  })
  await writeFile(options.readyPath, 'ready\n', 'utf8')

  try {
    await withDeadline(accepted, options.timeoutMs, 'observer acceptance deadline exceeded')
  } catch (error: unknown) {
    failures.push(normalizeError(error).message)
  }

  videoEndReason ??= 'observer-complete'
  await room.disconnect()
  for (const timer of subscriptionTimers) clearTimeout(timer)
  subscriptionTimers.clear()
  await Promise.allSettled(streamTasks)
  const finishedAtMs = Date.now()
  const acceptedResult =
    failures.length === 0 &&
    (options.allowVideoGaps
      ? videoDecoded >= options.minimumVideoFrames
      : maximumConsecutiveFrames >= options.minimumVideoFrames) &&
    audioPulses >= options.minimumAudioPulses &&
    tracksSubscribed >= options.expectedSubscriptions &&
    (!options.expectVideoEnd || videoEndReason !== 'observer-complete') &&
    audioFramesAfterVideoEnd >= options.minimumAudioFramesAfterVideoEnd &&
    videoLatencies.length === videoDecoded &&
    videoLatencies.length > 0 &&
    Math.max(...videoLatencies) <= options.maximumVideoLatencyMs &&
    outOfOrderFrames === 0 &&
    staleVideoFrames === 0
  const latencyTotal = videoLatencies.reduce((sum, value) => sum + value, 0)
  const sortedLatencies = [...videoLatencies].sort((left, right) => left - right)
  const percentile = (ratio: number): number | null => {
    if (sortedLatencies.length === 0) return null
    return sortedLatencies[Math.min(
      sortedLatencies.length - 1,
      Math.ceil(sortedLatencies.length * ratio) - 1,
    )] ?? null
  }
  return {
    schemaVersion: 1,
    accepted: acceptedResult,
    startedAt: new Date(startedAtMs).toISOString(),
    finishedAt: new Date(finishedAtMs).toISOString(),
    durationMs: finishedAtMs - startedAtMs,
    video: {
      receivedFrames: videoReceived,
      decodedFrames: videoDecoded,
      maximumConsecutiveFrames,
      sequenceGaps,
      outOfOrderFrames,
      duplicateFrames,
      minimumLatencyMs: videoLatencies.length > 0 ? Math.min(...videoLatencies) : null,
      maximumLatencyMs: videoLatencies.length > 0 ? Math.max(...videoLatencies) : null,
      averageLatencyMs:
        videoLatencies.length > 0 ? latencyTotal / videoLatencies.length : null,
      invalidTimestampFrames: invalidVideoTimestamps,
      observerDroppedFrames,
      maximumObserverBacklogFrames,
      firstSequence: firstVideoSequence ?? null,
      lastSequence: reportLastVideoSequence ?? null,
      p50LatencyMs: percentile(0.5),
      p95LatencyMs: percentile(0.95),
      staleFrames: staleVideoFrames,
      resolutionTransitions,
      resolutions,
      maximumNoFrameDurationMs,
      contentChanges,
      endReason: videoEndReason,
    },
    audio: {
      receivedFrames: audioFrames,
      receivedSamples: audioSamples,
      controlPulses: audioPulses,
      discontinuities: audioDiscontinuities,
      framesAfterVideoEnd: audioFramesAfterVideoEnd,
    },
    tracks: {
      subscribed: tracksSubscribed,
      unsubscribed: tracksUnsubscribed,
    },
    failures,
  }
}

function normalizeError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error))
}

async function withDeadline<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new ObserverFailure(message)), timeoutMs)
      }),
    ])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

const program = Effect.gen(function* () {
  const options = yield* Effect.try({
    try: optionsFromEnvironment,
    catch: normalizeError,
  })
  const room = yield* Effect.acquireRelease(
    Effect.sync(() => new Room()),
    (ownedRoom) => Effect.tryPromise({
      try: () => ownedRoom.disconnect(),
      catch: normalizeError,
    }).pipe(Effect.ignore),
  )
  const report = yield* Effect.tryPromise({
    try: () => observe(room, options),
    catch: normalizeError,
  })
  yield* Effect.tryPromise({
    try: () => writeFile(options.reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8'),
    catch: normalizeError,
  })
  yield* Effect.sync(() => process.stdout.write(`${JSON.stringify(report)}\n`))
  if (!report.accepted) return yield* Effect.fail(new ObserverFailure('media acceptance failed'))
})

Effect.runPromise(Effect.scoped(program)).then(
  () => dispose(),
  (error: unknown) => {
    dispose()
    process.stderr.write(`${normalizeError(error).message}\n`)
    process.exitCode = 1
  },
)
