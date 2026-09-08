import { Room, RoomEvent, TrackKind, TrackSource, VideoBufferType, VideoStream, dispose, type RemoteTrack } from '@livekit/rtc-node'
import { Schema } from 'effect'
import { writeFile } from 'node:fs/promises'

const env = Schema.decodeUnknownSync(Schema.Struct({
  LIVEKIT_URL: Schema.String,
  LIVEKIT_OBSERVER_TOKEN: Schema.String,
  MEDIA_LAB_READY_PATH: Schema.String,
  MEDIA_LAB_REPORT_PATH: Schema.String,
  MEDIA_LAB_CAMERA_SECONDS: Schema.String,
}))(process.env)
const seconds = Number(env.MEDIA_LAB_CAMERA_SECONDS)
if (!Number.isInteger(seconds) || seconds < 24 || seconds > 1800) throw new Error('Invalid camera duration')
const room = new Room()
const startedAt = Date.now()
const buckets = Array.from({ length: seconds + 30 }, (_, index) => ({
  atUnixMs: startedAt + index * 1000, frames: 0, maximumAgeMs: 0,
}))
const ages = new Uint32Array(5001)
const resolutions: { width: number, height: number, generation: number, atUnixMs: number }[] = []
const failures: string[] = []
const terminalFrames: { atUnixMs: number, width: number, height: number }[] = []
let frames = 0, changes = 0, subscribed = 0, unsubscribed = 0, reconnects = 0
let previousSequence = 0, previousGeneration = 0, previousWidth = 0, lastAt = 0, maximumGapMs = 0
let regressed = 0, maximumAgeMs = 0
let publicationSid: string | undefined
let publicationSource: TrackSource | undefined
let unsubscribedAt: number | undefined
let readerTask: Promise<void> | undefined
let cancelReader: (() => Promise<void>) | undefined
async function consume(track: RemoteTrack) {
  const reader = new VideoStream(track).getReader()
  cancelReader = async () => { await reader.cancel() }
  try {
    for (;;) {
      const result = await reader.read()
      if (result.done) break
      const now = Date.now()
      const input = result.value.frame
      const frame = input.type === VideoBufferType.I420 ? input : input.convert(VideoBufferType.I420)
      // The SFU closes VP8 downtracks with 8x8 decoder-reset keyframes. They
      // must occur only at terminal unpublish, never amid the camera stream.
      if (frame.width === 8 && frame.height === 8) {
        if (terminalFrames.length >= 16) throw new Error('Too many SFU terminal reset frames')
        terminalFrames.push({ atUnixMs: now, width: frame.width, height: frame.height })
        continue
      }
      if (frame.width < 528 || frame.height < 96)
        throw new Error(`Camera frame is smaller than marker: ${frame.width}x${frame.height} at ${now}`)
      if (terminalFrames.length) throw new Error('Camera frames resumed after an SFU terminal reset')
      const barcode = (y: number) => {
        let value = 0
        for (let bit = 0; bit < 32; ++bit) {
          let light = 0
          for (let dy = -2; dy <= 2; ++dy) for (let dx = -2; dx <= 2; ++dx) {
            if (frame.data[(y + dy) * frame.width + 24 + bit * 16 + dx]! > 128) ++light
          }
          if (light >= 13) value += 2 ** bit
        }
        return value
      }
      const sequence = barcode(32), generation = barcode(56), capturedMs = barcode(80)
      const age = ((now % 2 ** 32) - capturedMs + 2 ** 32) % 2 ** 32
      maximumAgeMs = Math.max(maximumAgeMs, age)
      ++ages[Math.min(5000, age)]!
      if (generation < previousGeneration || (generation === previousGeneration && sequence < previousSequence)) ++regressed
      if (generation !== previousGeneration || sequence !== previousSequence) ++changes
      if (generation !== previousGeneration || frame.width !== previousWidth) {
        if (resolutions.length >= 32) throw new Error('Camera changed generations unexpectedly often')
        resolutions.push({ width: frame.width, height: frame.height, generation, atUnixMs: now })
      }
      previousGeneration = generation
      previousSequence = sequence
      previousWidth = frame.width
      ++frames
      if (lastAt) maximumGapMs = Math.max(maximumGapMs, now - lastAt)
      lastAt = now
      const bucket = buckets[Math.floor((now - startedAt) / 1000)]
      if (!bucket) throw new Error('Camera observation exceeded time budget')
      ++bucket.frames
      bucket.maximumAgeMs = Math.max(bucket.maximumAgeMs, age)
    }
  } finally { cancelReader = undefined; reader.releaseLock() }
}
room.on(RoomEvent.TrackSubscribed, (track, publication, participant) => {
  if (participant.identity !== 'native-v2-publisher' || track.kind !== TrackKind.KIND_VIDEO) return
  ++subscribed
  if (subscribed !== 1) { failures.push('Camera was republished'); return }
  publicationSid = publication.sid
  publicationSource = publication.source
  if (publicationSource !== TrackSource.SOURCE_CAMERA) failures.push('Camera publication has the wrong source kind')
  readerTask = consume(track).catch(error => { failures.push(String(error)) })
})
room.on(RoomEvent.TrackUnsubscribed, (track, _publication, participant) => {
  if (participant.identity !== 'native-v2-publisher' || track.kind !== TrackKind.KIND_VIDEO) return
  ++unsubscribed
  unsubscribedAt = Date.now()
  void cancelReader?.().catch(error => { failures.push(String(error)) })
})
room.on(RoomEvent.Reconnecting, () => { ++reconnects })
try {
  await room.connect(env.LIVEKIT_URL, env.LIVEKIT_OBSERVER_TOKEN, { autoSubscribe: true, dynacast: false })
  await writeFile(env.MEDIA_LAB_READY_PATH, 'ready\n')
  const deadline = performance.now() + (seconds + 25) * 1000
  while (!unsubscribed && performance.now() < deadline) await new Promise(resolve => setTimeout(resolve, 50))
  if (unsubscribed !== 1) failures.push('Camera did not unpublish before deadline')
} catch (error) { failures.push(String(error)) }
finally {
  await cancelReader?.().catch(() => undefined)
  await room.disconnect()
  await readerTask
  await dispose()
}
let ageCount = 0, p95AgeMs = 0
for (let age = 0; age < ages.length; ++age) {
  ageCount += ages[age]!
  if (ageCount >= frames * 0.95) { p95AgeMs = age; break }
}
if (subscribed !== 1 || reconnects || frames < seconds * 20 || changes < frames * 0.9 || regressed) {
  failures.push('Camera frame continuity or generation ordering failed')
}
if (!resolutions.some(value => value.width === 1280 && value.height === 720 && value.generation === 1) ||
    !resolutions.some(value => value.width === 1920 && value.height === 1080 && value.generation === 2) ||
    !resolutions.some(value => value.width === 1280 && value.height === 720 && value.generation === 3)) {
  failures.push('Camera 720/1080/720 profile changes were not decoded')
}
if (p95AgeMs > 250 || maximumGapMs > 1000) failures.push('Camera receive age or gap exceeded budget')
if (terminalFrames.some(frame => unsubscribedAt === undefined || frame.atUnixMs < unsubscribedAt - 500 ||
    frame.atUnixMs > unsubscribedAt + 200)) failures.push('SFU reset frame occurred outside terminal unpublish')
const report = { accepted: failures.length === 0, failures, seconds, frames, changes, subscribed, unsubscribed,
  reconnects, publicationSid, publicationSource, resolutions, regressed, p95AgeMs, maximumAgeMs, maximumGapMs,
  terminalFrames, unsubscribedAt,
  windows: buckets.filter(bucket => bucket.frames > 0) }
await writeFile(env.MEDIA_LAB_REPORT_PATH, JSON.stringify(report, null, 2))
console.log(JSON.stringify({ ...report, windows: undefined }))
if (!report.accepted) process.exitCode = 1
