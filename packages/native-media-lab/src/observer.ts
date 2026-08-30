import {
  AudioStream,
  dispose,
  Room,
  RoomEvent,
  TrackKind,
  VideoStream,
  type RemoteTrack,
} from '@livekit/rtc-node'
import { Effect, Schema } from 'effect'
import { writeFile } from 'node:fs/promises'
import { decodeVideoMarker } from './marker.js'

const ObserverEnvironment = Schema.Struct({
  LIVEKIT_URL: Schema.String,
  LIVEKIT_OBSERVER_TOKEN: Schema.String,
  MEDIA_LAB_REPORT_PATH: Schema.String,
  MEDIA_LAB_READY_PATH: Schema.String,
  MEDIA_LAB_MIN_VIDEO_FRAMES: Schema.optional(Schema.String),
  MEDIA_LAB_MIN_AUDIO_PULSES: Schema.optional(Schema.String),
  MEDIA_LAB_TIMEOUT_MS: Schema.optional(Schema.String),
  MEDIA_LAB_OBSERVER_DELAY_MS: Schema.optional(Schema.String),
  MEDIA_LAB_ALLOW_VIDEO_GAPS: Schema.optional(Schema.String),
  MEDIA_LAB_EXPECT_SUBSCRIPTIONS: Schema.optional(Schema.String),
  MEDIA_LAB_MAX_VIDEO_LATENCY_MS: Schema.optional(Schema.String),
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
  readonly allowVideoGaps: boolean
  readonly expectedSubscriptions: number
  readonly maximumVideoLatencyMs: number
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
    readonly minimumLatencyMs: number | null
    readonly maximumLatencyMs: number | null
    readonly averageLatencyMs: number | null
    readonly observerDroppedFrames: number
    readonly maximumObserverBacklogFrames: number
  }
  readonly audio: {
    readonly receivedFrames: number
    readonly receivedSamples: number
    readonly controlPulses: number
    readonly discontinuities: number
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
  }
}

async function observe(room: Room, options: ObserverOptions): Promise<VerificationReport> {
  const startedAtMs = Date.now()
  const failures: string[] = []
  const videoLatencies: number[] = []
  let videoReceived = 0
  let videoDecoded = 0
  let maximumConsecutiveFrames = 0
  let currentConsecutiveFrames = 0
  let sequenceGaps = 0
  let outOfOrderFrames = 0
  let observerDroppedFrames = 0
  let maximumObserverBacklogFrames = 0
  let lastVideoSequence: number | undefined
  let audioFrames = 0
  let audioSamples = 0
  let audioPulses = 0
  let audioDiscontinuities = 0
  let lastAudioFrameAt: number | undefined
  let pulseActive = false
  let lastPulseAt = 0
  let tracksSubscribed = 0
  let tracksUnsubscribed = 0
  const streamTasks = new Set<Promise<void>>()

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
      audioPulses >= options.minimumAudioPulses &&
      tracksSubscribed >= options.expectedSubscriptions
    ) resolveAccepted?.()
  }

  const consumeVideo = async (track: RemoteTrack) => {
    const reader = new VideoStream(track).getReader()
    let nextProcessingAt = 0
    try {
      while (true) {
        const result = await reader.read()
        if (result.done) break
        videoReceived += 1
        const receivedAt = Date.now()
        if (options.delayMs > 0 && receivedAt < nextProcessingAt) {
          observerDroppedFrames += 1
          maximumObserverBacklogFrames = 1
          continue
        }
        nextProcessingAt = receivedAt + options.delayMs
        const marker = decodeVideoMarker(result.value.frame)
        if (marker !== undefined) {
          videoDecoded += 1
          const latency = Date.now() - marker.capturedAtMs
          if (latency >= 0 && latency < options.timeoutMs) videoLatencies.push(latency)
          if (lastVideoSequence === undefined || marker.sequence === lastVideoSequence + 1) {
            currentConsecutiveFrames += 1
          } else if (marker.sequence <= lastVideoSequence) {
            outOfOrderFrames += 1
            currentConsecutiveFrames = 1
          } else {
            sequenceGaps += marker.sequence - lastVideoSequence - 1
            currentConsecutiveFrames = 1
          }
          lastVideoSequence = marker.sequence
          maximumConsecutiveFrames = Math.max(
            maximumConsecutiveFrames,
            currentConsecutiveFrames,
          )
        }
        checkAcceptance()
      }
    } finally {
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
    if (track.kind === TrackKind.KIND_VIDEO) startStream(consumeVideo(track))
    if (track.kind === TrackKind.KIND_AUDIO) startStream(consumeAudio(track))
  })
  room.on(RoomEvent.TrackUnsubscribed, (_track, _publication, participant) => {
    if (participant.identity === 'native-v2-publisher') tracksUnsubscribed += 1
  })

  await room.connect(options.url, options.token, {
    autoSubscribe: true,
    dynacast: false,
  })
  await writeFile(options.readyPath, 'ready\n', 'utf8')

  try {
    await withDeadline(accepted, options.timeoutMs, 'observer acceptance deadline exceeded')
  } catch (error: unknown) {
    failures.push(normalizeError(error).message)
  }

  await room.disconnect()
  await Promise.allSettled(streamTasks)
  const finishedAtMs = Date.now()
  const acceptedResult =
    failures.length === 0 &&
    (options.allowVideoGaps
      ? videoDecoded >= options.minimumVideoFrames
      : maximumConsecutiveFrames >= options.minimumVideoFrames) &&
    audioPulses >= options.minimumAudioPulses &&
    tracksSubscribed >= options.expectedSubscriptions &&
    (videoLatencies.length === 0 ||
      Math.max(...videoLatencies) <= options.maximumVideoLatencyMs)
  const latencyTotal = videoLatencies.reduce((sum, value) => sum + value, 0)
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
      minimumLatencyMs: videoLatencies.length > 0 ? Math.min(...videoLatencies) : null,
      maximumLatencyMs: videoLatencies.length > 0 ? Math.max(...videoLatencies) : null,
      averageLatencyMs:
        videoLatencies.length > 0 ? latencyTotal / videoLatencies.length : null,
      observerDroppedFrames,
      maximumObserverBacklogFrames,
    },
    audio: {
      receivedFrames: audioFrames,
      receivedSamples: audioSamples,
      controlPulses: audioPulses,
      discontinuities: audioDiscontinuities,
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
