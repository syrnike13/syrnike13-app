import { AudioStream, VideoStream, Room, RoomEvent, TrackKind, dispose, type RemoteTrack } from '@livekit/rtc-node'
import { Schema } from 'effect'
import { writeFile } from 'node:fs/promises'
import { pulseCode, type SyncPulse } from './audio-sync-evidence.js'
import { decodeVideoMarker } from './marker.js'

const env = Schema.decodeUnknownSync(Schema.Struct({
  LIVEKIT_URL: Schema.String, LIVEKIT_OBSERVER_TOKEN: Schema.String,
  MEDIA_LAB_READY_PATH: Schema.String, MEDIA_LAB_REPORT_PATH: Schema.String,
  MEDIA_LAB_AUDIO_DURATION_MS: Schema.String,
}))(process.env)
const duration = Number(env.MEDIA_LAB_AUDIO_DURATION_MS)
if (!Number.isSafeInteger(duration) || duration < 5000 || duration > 1260_000) throw new Error('Invalid duration')
const room = new Room(), readers: Promise<void>[] = [], failures: string[] = []
const audio: SyncPulse[] = [], identities: string[] = []
const histogram = new Uint32Array(2002)
const minutes = Array.from({ length: 22 }, () => ({ frames: 0, ageSum: 0, maxAge: 0, maxGap: 0, sequenceDrops: 0 }))
const minuteHistograms = Array.from({ length: 22 }, () => new Uint32Array(2002))
let firstAt = 0, lastAt = 0, lastSequence = 0, generation = 0
let frames = 0, invalidMarkers = 0, maximumAgeMs = 0, maximumGapMs = 0, sequenceDrops = 0
let audioFrames = 0, lastAudioAt = 0, maximumAudioGapMs = 0, unpublished = 0, reconnects = 0
const rtcSamples: { atMs: number; bytesReceived: number; framesDecoded: number; framesDropped: number; packetsLost: number }[] = []
async function video(track: RemoteTrack) {
  const reader = new VideoStream(track).getReader()
  try {
    for (;;) {
      const next = await reader.read()
      if (next.done) break
      const now = Date.now(), frame = next.value.frame
      if (!firstAt) firstAt = now
      ++frames
      if (frame.width !== 1920 || frame.height !== 1080) throw new Error(`Decoded dimensions changed: ${frame.width}x${frame.height} at ${now}, elapsed ${now - firstAt}ms`)
      const minuteIndex = Math.min(21, Math.floor((now - firstAt) / 60_000))
      const minute = minutes[minuteIndex]!
      ++minute.frames
      if (lastAt) { const gap = now - lastAt; maximumGapMs = Math.max(maximumGapMs, gap); minute.maxGap = Math.max(minute.maxGap, gap) }
      lastAt = now
      const marker = decodeVideoMarker(frame)
      if (!marker) { ++invalidMarkers; continue }
      if (generation && marker.generation !== generation) throw new Error('Source generation changed')
      generation = marker.generation
      const age = now - marker.capturedAtMs
      if (age < 0) throw new Error('Invalid capture clock')
      histogram[Math.min(2001, Math.floor(age))]!++
      minuteHistograms[minuteIndex]![Math.min(2001, Math.floor(age))]!++
      maximumAgeMs = Math.max(maximumAgeMs, age); minute.ageSum += age; minute.maxAge = Math.max(minute.maxAge, age)
      if (lastSequence && marker.sequence > lastSequence + 1) {
        const missing = marker.sequence - lastSequence - 1; sequenceDrops += missing; minute.sequenceDrops += missing
      }
      lastSequence = marker.sequence
    }
  } finally { reader.releaseLock() }
}
async function sound(track: RemoteTrack) {
  const reader = new AudioStream(track, { sampleRate: 48_000, numChannels: 1, frameSizeMs: 10 }).getReader()
  let active = false, best = 0
  try {
    for (;;) {
      const next = await reader.read()
      if (next.done) break
      ++audioFrames
      const now = Number(process.hrtime.bigint()) / 1e6
      if (lastAudioAt) maximumAudioGapMs = Math.max(maximumAudioGapMs, now - lastAudioAt)
      lastAudioAt = now
      const pulse = pulseCode(next.value.data)
      if (pulse.rms > 200) {
        if (!active) {
          if (audio.length >= 1400) throw new Error('Audio evidence capacity exceeded')
          audio.push({ atMs: now, code: pulse.code }); best = 0
        }
        if (pulse.rms > best) { audio.at(-1)!.code = pulse.code; best = pulse.rms }
        active = true
      } else if (pulse.rms < 100) active = false
    }
  } finally { reader.releaseLock() }
}
room.on(RoomEvent.TrackSubscribed, (track, publication, participant) => {
  if (participant.identity !== 'native-v2-publisher') return
  if (!publication.sid) { failures.push('Missing publication SID'); return }
  identities.push(publication.sid)
  readers.push((track.kind === TrackKind.KIND_VIDEO ? video(track) : sound(track)).catch(error => { failures.push(String(error)) }))
})
room.on(RoomEvent.TrackUnsubscribed, (_track, _publication, participant) => { if (participant.identity === 'native-v2-publisher') ++unpublished })
room.on(RoomEvent.Reconnecting, () => { ++reconnects })
try {
  await room.connect(env.LIVEKIT_URL, env.LIVEKIT_OBSERVER_TOKEN, { autoSubscribe: true, dynacast: false })
  await writeFile(env.MEDIA_LAB_READY_PATH, 'ready\n')
  const deadline = performance.now() + duration + 30_000
  let lastStats = 0
  while (performance.now() < deadline && !(identities.length >= 2 && unpublished >= identities.length)) {
    if (performance.now() - lastStats >= 500) {
      lastStats = performance.now()
      // Serial await: at most one SDK stats request exists at a time.
      const stats = await room.getRtcStats()
      for (const item of [...stats.subscriberStats, ...stats.publisherStats]) {
        if (item.stats.case !== 'inboundRtp' || item.stats.value.stream?.kind !== 'video') continue
        const value = item.stats.value
        if (rtcSamples.length >= 2600) throw new Error('RTC evidence capacity exceeded')
        rtcSamples.push({ atMs: Date.now(), bytesReceived: Number(value.inbound?.bytesReceived ?? 0),
          framesDecoded: Number(value.inbound?.framesDecoded ?? 0), framesDropped: Number(value.inbound?.framesDropped ?? 0),
          packetsLost: Number(value.received?.packetsLost ?? 0) })
      }
    }
    await new Promise(resolve => setTimeout(resolve, 20))
  }
  if (unpublished !== 2) failures.push('Publication did not finish normally')
} catch (error) { failures.push(String(error)) }
finally { await room.disconnect(); await Promise.all(readers); await dispose() }
let cumulative = 0, p95AgeMs = 0
for (let age = 0; age < histogram.length; ++age) {
  cumulative += histogram[age]!
  if (cumulative >= (frames - invalidMarkers) * 0.95) { p95AgeMs = age; break }
}
if (identities.length !== 2 || new Set(identities).size !== 2 || reconnects) failures.push('Publication/subscription identity changed')
if (frames < 100 || lastAt - firstAt < duration - 5000) failures.push('Insufficient full-run video output')
if (invalidMarkers > frames * 0.01 || p95AgeMs > 150 || maximumAgeMs > 1500) failures.push('Receiver freshness failed')
const populated = minutes.filter(minute => minute.frames > 0)
const average = (minute: typeof minutes[number]) => minute.ageSum / minute.frames
if (duration >= 1200_000 && average(populated.at(-2)!) - average(populated[0]!) > 20) failures.push('Receiver age grew over 20 ms')
if (audio.length < duration / 1000 * 0.8) failures.push('Insufficient independent audio pulses')
const report = { accepted: failures.length === 0, failures, duration, firstAt, lastAt, frames, invalidMarkers,
  p95AgeMs, maximumAgeMs, maximumGapMs, sequenceDrops, identities, generation, reconnects, unpublished,
  audioFrames, maximumAudioGapMs, audio, minutes: minutes.map((minute, index) => {
    let count = 0, p95AgeMs = 0
    for (let age = 0; age < 2002; ++age) {
      count += minuteHistograms[index]![age]!
      if (count >= minute.frames * 0.95) { p95AgeMs = age; break }
    }
    return { ...minute, p95AgeMs }
  }), rtcSamples, ageHistogram: Array.from(histogram) }
await writeFile(env.MEDIA_LAB_REPORT_PATH, JSON.stringify(report, null, 2))
console.log(JSON.stringify({ accepted: report.accepted, failures, frames, p95AgeMs, maximumAgeMs, maximumGapMs }))
if (!report.accepted) process.exitCode = 1
