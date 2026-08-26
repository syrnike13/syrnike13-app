import { performance } from 'node:perf_hooks'

import { Schema } from 'effect'

import { NATIVE_RUNTIME_LIVEKIT_VERSION } from '../main/native-runtime/native-artifacts'
import { runNativeUtilityHost } from './runtime-host'

type ParentPort = {
  on(event: 'message', listener: (event: { data: unknown }) => void): void
  postMessage(message: unknown): void
}

const ParentPortSchema = Schema.declare<ParentPort>(
  (input): input is ParentPort =>
    typeof input === 'object' &&
    input !== null &&
    typeof Reflect.get(input, 'on') === 'function' &&
    typeof Reflect.get(input, 'postMessage') === 'function',
)

const processParentPort: unknown = Reflect.get(process, 'parentPort')
if (!Schema.is(ParentPortSchema)(processParentPort)) {
  throw new Error('Microphone resilience utility has no Electron parent port')
}
const parentPort = processParentPort
// The dedicated addon is compiled with the repository's N-API 8 ABI. Keep the
// synthetic manifest exact so the production handshake still checks the addon.
const RESILIENCE_ADDON_NAPI_VERSION = 8
let runtime: object | undefined
let segmentRunning = false

function runtimeMethod(name: string) {
  if (!runtime) throw new Error('Native resilience runtime is not created')
  const method = Reflect.get(runtime, name)
  if (typeof method !== 'function') {
    throw new Error(`Native resilience runtime has no ${name} method`)
  }
  return (...args: readonly unknown[]) => Reflect.apply(method, runtime, args)
}

function positiveInteger(value: unknown, name: string) {
  if (!Number.isSafeInteger(value) || Number(value) <= 0) {
    throw new Error(`${name} must be a positive safe integer`)
  }
  return Number(value)
}

function startSegment(message: object) {
  if (segmentRunning) throw new Error('A resilience segment is already running')
  const requestId = Reflect.get(message, 'requestId')
  if (typeof requestId !== 'string' || requestId.length === 0) {
    throw new Error('Resilience segment requires a requestId')
  }
  const frames = positiveInteger(Reflect.get(message, 'frames'), 'frames')
  const realtime = Reflect.get(message, 'realtime') === true
  const submit = runtimeMethod('submitMicrophoneFrame')
  const snapshot = runtimeMethod('resilienceSnapshot')
  segmentRunning = true
  let submitted = 0
  let maximumLagMs = 0
  const startedAt = performance.now()
  let nextFrameAt = startedAt

  const fail = (error: unknown) => {
    segmentRunning = false
    parentPort.postMessage({
      type: 'microphoneResilienceSegmentFailed',
      requestId,
      error: error instanceof Error ? error.message : String(error),
    })
  }
  const tick = () => {
    try {
      if (realtime) {
        const now = performance.now()
        maximumLagMs = Math.max(maximumLagMs, Math.max(0, now - nextFrameAt))
        if (maximumLagMs > 250) {
          throw new Error('Microphone resilience segment exceeded 250ms cadence lag')
        }
      }
      if (submit(false) !== true) {
        throw new Error('Current utility-owned capture epoch rejected PCM')
      }
      submitted += 1
      if (submitted === frames) {
        segmentRunning = false
        parentPort.postMessage({
          type: 'microphoneResilienceSegmentComplete',
          requestId,
          frames: submitted,
          wallMilliseconds: performance.now() - startedAt,
          maximumLagMilliseconds: maximumLagMs,
          snapshot: snapshot(),
        })
        return
      }
      if (realtime) {
        nextFrameAt += 10
        setTimeout(tick, Math.max(0, nextFrameAt - performance.now()))
      } else {
        setImmediate(tick)
      }
    } catch (error) {
      fail(error)
    }
  }
  if (realtime) nextFrameAt += 10
  setImmediate(tick)
}

parentPort.on('message', (event) => {
  const message = event.data
  if (
    typeof message !== 'object' ||
    message === null ||
    Reflect.get(message, 'type') !== 'microphoneResilienceControl'
  ) {
    return
  }
  const requestId = Reflect.get(message, 'requestId')
  try {
    const action = Reflect.get(message, 'action')
    if (action === 'startSegment') {
      startSegment(message)
      parentPort.postMessage({
        type: 'microphoneResilienceControlReply',
        requestId,
        ok: true,
      })
      return
    }
    if (action === 'snapshot') {
      parentPort.postMessage({
        type: 'microphoneResilienceControlReply',
        requestId,
        ok: true,
        snapshot: runtimeMethod('resilienceSnapshot')(),
      })
      return
    }
    throw new Error(`Unknown resilience control action: ${String(action)}`)
  } catch (error) {
    parentPort.postMessage({
      type: 'microphoneResilienceControlReply',
      requestId,
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    })
  }
})

void runNativeUtilityHost('media', {
  verifyDistribution: (_root, expected) => ({
    schemaVersion: 1,
    contractVersion: expected.contractVersion,
    platform: 'win32',
    arch: 'x64',
    appVersion: expected.appVersion,
    releaseChannel: expected.releaseChannel,
    commitSha: expected.commitSha,
    electronVersion: expected.electronVersion,
    napiVersion: RESILIENCE_ADDON_NAPI_VERSION,
    liveKitVersion: NATIVE_RUNTIME_LIVEKIT_VERSION,
    files: [],
  }),
  onRuntimeCreated: (createdRuntime) => {
    runtime = createdRuntime
  },
}).catch((error) => {
  console.error(error)
  process.exit(1)
})
