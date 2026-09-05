import { AudioStream, VideoStream, VideoBufferType, Room, RoomEvent, TrackKind, dispose, type RemoteTrack } from '@livekit/rtc-node'
import { Schema } from 'effect'
import { writeFile } from 'node:fs/promises'
import { pulseCode, verifyAudioSync, type SyncPulse } from './audio-sync-evidence.js'
import { decodeVideoMarker } from './marker.js'

const env = Schema.decodeUnknownSync(Schema.Struct({
  LIVEKIT_URL: Schema.String, LIVEKIT_OBSERVER_TOKEN: Schema.String,
  MEDIA_LAB_READY_PATH: Schema.String, MEDIA_LAB_REPORT_PATH: Schema.String,
  MEDIA_LAB_AUDIO_DURATION_MS: Schema.String,
}))(process.env)
const duration = Number(env.MEDIA_LAB_AUDIO_DURATION_MS)
const scenario = process.env.MEDIA_LAB_AUDIO_SCENARIO ?? 'sync'
if (!['sync', 'system', 'process-isolation', 'audio-stop', 'video-stop', 'audio-loss', 'source-close', 'slow-source', 'audio-cycles', 'default-output'].includes(scenario)) throw new Error('Invalid audio scenario')
if (!Number.isSafeInteger(duration) || duration < 5000 || duration > 660_000) throw new Error('Invalid audio observation duration')
const room = new Room()
const video: SyncPulse[] = [], audio: SyncPulse[] = [], failures: string[] = []
const readers: Promise<void>[] = []
let subscribed = 0, unpublished = 0, reconnects = 0, audioFrames = 0, videoFrames = 0
let audioPublications = 0, videoPublications = 0
let audioEnded = false, videoEnded = false, videoFramesAfterAudioEnd = 0, audioFramesAfterVideoEnd = 0
let audioPulsesAfterVideoEnd = 0
const monotonicMs = () => Number(process.hrtime.bigint()) / 1e6
const videoAges = new Uint32Array(2001)
let measuredVideoFrames = 0
let lastAudioAtMs = 0, maximumAudioDeliveryGapMs = 0, audioDeliveryGapsOver100Ms = 0
let receivedAudioSamples = 0
async function consumeVideo(track: RemoteTrack) {
  const reader = new VideoStream(track).getReader()
  let flashing = false
  try {
    for (;;) {
      const next = await reader.read()
      if (next.done) break
      const frame = next.value.frame.type === VideoBufferType.I420 ? next.value.frame : next.value.frame.convert(VideoBufferType.I420)
      ++videoFrames
      if (audioEnded) ++videoFramesAfterAudioEnd
      const marker = decodeVideoMarker(frame)
      if (marker) {
        const age = Date.now() - marker.capturedAtMs
        if (age >= 0 && age <= 2000) { videoAges[Math.floor(age)]!++; ++measuredVideoFrames }
      }
      const value = (x: number, y: number) => frame.data[Math.floor(frame.height * y) * frame.width + Math.floor(frame.width * x)] ?? 0
      const bright = value(0.5, 0.75) > 180
      if (bright && !flashing) {
        let code = 0
        for (let bit = 0; bit < 4; ++bit) if (value((2.5 + bit) / 8, 0.35) > 128) code |= 1 << bit
        if (video.length >= 700) throw new Error('Visual pulse capacity exceeded')
        video.push({ atMs: monotonicMs(), code })
      }
      flashing = bright
    }
  } finally { reader.releaseLock() }
}
async function consumeAudio(track: RemoteTrack) {
  const reader = new AudioStream(track, { sampleRate: 48_000, numChannels: 1, frameSizeMs: 10 }).getReader()
  let active = false, bestRms = 0
  try {
    for (;;) {
      const next = await reader.read()
      if (next.done) break
      ++audioFrames
      const receivedAtMs = monotonicMs()
      if (lastAudioAtMs) {
        const gap = receivedAtMs - lastAudioAtMs
        maximumAudioDeliveryGapMs = Math.max(maximumAudioDeliveryGapMs, gap)
        if (gap > 100) ++audioDeliveryGapsOver100Ms
      }
      lastAudioAtMs = receivedAtMs
      receivedAudioSamples += next.value.data.length
      if (videoEnded) ++audioFramesAfterVideoEnd
      const pulse = pulseCode(next.value.data)
      if (pulse.rms > 200) {
        if (!active) {
          if (videoEnded) ++audioPulsesAfterVideoEnd
          if (audio.length >= 700) throw new Error('Audio pulse capacity exceeded')
          audio.push({ atMs: monotonicMs(), code: pulse.code }); bestRms = 0
        }
        if (pulse.rms > bestRms) { audio.at(-1)!.code = pulse.code; bestRms = pulse.rms }
        active = true
      } else if (pulse.rms < 100) active = false
    }
  } finally { reader.releaseLock() }
}
room.on(RoomEvent.TrackSubscribed, (track, _publication, participant) => {
  if (participant.identity !== 'native-v2-publisher') return
  ++subscribed
  if (track.kind === TrackKind.KIND_AUDIO) ++audioPublications
  else ++videoPublications
  readers.push((track.kind === TrackKind.KIND_VIDEO ? consumeVideo(track) : consumeAudio(track))
    .catch(error => { failures.push(String(error)) }))
})
room.on(RoomEvent.TrackUnsubscribed, (track, _publication, participant) => {
  if (participant.identity !== 'native-v2-publisher') return
  ++unpublished
  if (track.kind === TrackKind.KIND_AUDIO) audioEnded = true
  if (track.kind === TrackKind.KIND_VIDEO) videoEnded = true
})
room.on(RoomEvent.Reconnecting, () => { ++reconnects })
try {
  await room.connect(env.LIVEKIT_URL, env.LIVEKIT_OBSERVER_TOKEN, { autoSubscribe: true, dynacast: false })
  await writeFile(env.MEDIA_LAB_READY_PATH, 'ready\n')
  const deadline = performance.now() + duration + 30_000
  while (performance.now() < deadline && !(subscribed >= 2 && unpublished >= subscribed)) await new Promise(resolve => setTimeout(resolve, 50))
  if (unpublished < 2) failures.push('screen audio publication did not finish')
} catch (error) { failures.push(String(error)) }
finally { await room.disconnect(); await Promise.all(readers); await dispose() }
const evidence = ['sync', 'system', 'process-isolation', 'slow-source', 'default-output'].includes(scenario)
  ? verifyAudioSync(video, audio, duration) : { accepted: true, failures: [] as string[] }
if (['audio-stop', 'audio-loss'].includes(scenario) && videoFramesAfterAudioEnd < 100) failures.push('Video did not continue after audio stopped')
if (['video-stop', 'source-close'].includes(scenario) && (audioFramesAfterVideoEnd < 500 || audioPulsesAfterVideoEnd < 3)) failures.push('Audible audio did not continue after video stopped')
if (reconnects) failures.push('Room reconnected during A/V measurement')
if (scenario === 'audio-cycles' && (audioPublications !== 30 || videoPublications !== 1)) failures.push('Lifecycle cycles changed video or missed audio publications')
let cumulative = 0, p95VideoAgeMs = 0
for (let age = 0; age < videoAges.length; ++age) {
  cumulative += videoAges[age]!
  if (cumulative >= measuredVideoFrames * 0.95) { p95VideoAgeMs = age; break }
}
const report = { ...evidence, accepted: evidence.accepted && failures.length === 0, failures: [...evidence.failures, ...failures], scenario, clock: 'machine-monotonic-ms', audioFrames, receivedAudioSamples, maximumAudioDeliveryGapMs, audioDeliveryGapsOver100Ms, videoFrames, videoFramesAfterAudioEnd, audioFramesAfterVideoEnd, audioPulsesAfterVideoEnd, measuredVideoFrames, p95VideoAgeMs, reconnects, audio, video }
await writeFile(env.MEDIA_LAB_REPORT_PATH, JSON.stringify({ ...report, audioPublications, videoPublications }, null, 2))
console.log(JSON.stringify(report))
if (!report.accepted) process.exitCode = 1
