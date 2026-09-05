import { Room, RoomEvent, TrackKind, VideoStream, dispose } from '@livekit/rtc-node'
import { writeFile } from 'node:fs/promises'
import { decodeVideoMarker } from '../dist/marker.js'

const room = new Room()
const report = { version: 1, frames: 0, subscriptions: [], reconnects: 0, failures: [], samples: [], sourceSizes: [] }
let reader, task, timer, ended = false, lastFrameAt = 0, lastSequence = 0, firstFrameAt = 0
let maximumGapMs = 0, invalidMarkers = 0, bucket = null
const latencies = []
let end
const complete = new Promise(resolve => { end = resolve })
room.on(RoomEvent.Reconnecting, () => { report.reconnects++ })
room.on(RoomEvent.Disconnected, () => { if (!ended) { report.failures.push('observer disconnected early'); end() } })
room.on(RoomEvent.TrackSubscribed, (track, publication, participant) => {
  if (participant.identity !== 'publisher' || track.kind !== TrackKind.KIND_VIDEO) return
  report.subscriptions.push(publication.sid)
  if (task) { report.failures.push('screen republished'); return }
  reader = new VideoStream(track).getReader()
  task = (async () => {
    while (true) {
      const result = await reader.read()
      if (result.done) break
      const now = Date.now(), marker = decodeVideoMarker(result.value.frame)
      if (!marker) { invalidMarkers++; continue }
      firstFrameAt ||= now
      if (lastFrameAt) maximumGapMs = Math.max(maximumGapMs, now - lastFrameAt)
      lastFrameAt = now
      if (marker.sequence <= lastSequence) report.failures.push('non-monotonic source sequence')
      lastSequence = marker.sequence
      const age = now - marker.capturedAtMs
      if (age < 0 || age > 10000) report.failures.push('invalid source timestamp')
      latencies.push(age)
      if (latencies.length > 8192) throw Error('Observer frame sample bound exceeded')
      const second = Math.floor(now / 1000)
      if (!bucket || bucket.second !== second) {
        bucket = { second, frames: 0, maxAgeMs: 0 }; report.samples.push(bucket)
      }
      bucket.frames++; bucket.maxAgeMs = Math.max(bucket.maxAgeMs, age)
      const size = `${marker.sourceWidth}x${marker.sourceHeight}`
      if (!report.sourceSizes.includes(size)) report.sourceSizes.push(size)
      report.frames++
    }
  })().catch(error => { report.failures.push(error.message); end() })
})
room.on(RoomEvent.TrackUnsubscribed, (_track, _publication, participant) => {
  if (participant.identity !== 'publisher') return
  ended = true; end()
})
try {
  await room.connect(process.env.LIVEKIT_URL, process.env.LIVEKIT_OBSERVER_TOKEN, { autoSubscribe: true, dynacast: false })
  console.log('preview-observer-ready')
  timer = setTimeout(() => { report.failures.push('observer deadline'); end() }, 95000)
  await complete
} catch (error) { report.failures.push(error.message) }
finally {
  clearTimeout(timer)
  ended = true
  if (reader) await reader.cancel().catch(() => {})
  await room.disconnect()
  if (task) await task
  reader?.releaseLock()
  await dispose()
}
latencies.sort((a, b) => a - b)
report.p95AgeMs = latencies[Math.max(0, Math.ceil(latencies.length * 0.95) - 1)] ?? null
report.maximumGapMs = maximumGapMs
report.invalidMarkers = invalidMarkers
report.firstFrameAt = firstFrameAt; report.lastFrameAt = lastFrameAt
report.averageFps = report.frames * 1000 / Math.max(1, lastFrameAt - firstFrameAt)
await writeFile(process.env.PREVIEW_OBSERVER_REPORT, JSON.stringify(report, null, 2))
process.exitCode = report.failures.length ? 1 : 0
