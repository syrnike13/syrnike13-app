import { AudioStream, Room, RoomEvent, TrackKind, dispose, type RemoteTrack } from '@livekit/rtc-node'
import { Schema } from 'effect'
import { writeFile } from 'node:fs/promises'

const env = Schema.decodeUnknownSync(Schema.Struct({
  LIVEKIT_URL: Schema.String, LIVEKIT_OBSERVER_TOKEN: Schema.String,
  MEDIA_LAB_READY_PATH: Schema.String, MEDIA_LAB_REPORT_PATH: Schema.String,
  MEDIA_LAB_MICROPHONE_SECONDS: Schema.String,
  MEDIA_LAB_MICROPHONE_REJOIN: Schema.optional(Schema.Literal('1')),
}))(process.env)
const seconds = Number(env.MEDIA_LAB_MICROPHONE_SECONDS)
if (!Number.isInteger(seconds) || seconds < 15 || seconds > 1800) throw new Error('Invalid microphone observation duration')
let room = new Room()
const rejoin = env.MEDIA_LAB_MICROPHONE_REJOIN === '1'
const startedAt = Date.now()
const energy = new Float64Array((seconds + 30) * 10)
const samples = new Uint32Array(energy.length)
let subscribed = 0, unsubscribed = 0, reconnects = 0, frames = 0, maximumGapMs = 0, lastAt = 0
let readerTask: Promise<void> | undefined
let publicationSid: string | undefined
let deliberateRejoins = 0
const failures: string[] = []
async function consume(track: RemoteTrack) {
  const reader = new AudioStream(track, { sampleRate: 48_000, numChannels: 1, frameSizeMs: 10 }).getReader()
  try {
    for (;;) {
      const result = await reader.read()
      if (result.done) break
      const now = Date.now()
      if (lastAt) maximumGapMs = Math.max(maximumGapMs, now - lastAt)
      lastAt = now
      ++frames
      const bucket = Math.floor((now - startedAt) / 100)
      if (bucket < 0 || bucket >= energy.length) throw new Error('Observer time window exhausted')
      for (const value of result.value.data) energy[bucket]! += value * value
      samples[bucket]! += result.value.data.length
    }
  } finally { reader.releaseLock() }
}
function observeRoom(observedRoom: Room) {
  observedRoom.on(RoomEvent.TrackSubscribed, (track, publication, participant) => {
    if (participant.identity !== 'native-v2-publisher' || track.kind !== TrackKind.KIND_AUDIO) return
    ++subscribed
    if (subscribed > deliberateRejoins + 1 || (publicationSid && publicationSid !== publication.sid)) {
      failures.push('Microphone was republished'); return
    }
    publicationSid = publication.sid
    readerTask = consume(track).catch(error => { failures.push(String(error)) })
  })
  observedRoom.on(RoomEvent.TrackUnsubscribed, (track, _publication, participant) => {
    if (participant.identity === 'native-v2-publisher' && track.kind === TrackKind.KIND_AUDIO) ++unsubscribed
  })
  observedRoom.on(RoomEvent.Reconnecting, () => { ++reconnects })
}
observeRoom(room)
try {
  await room.connect(env.LIVEKIT_URL, env.LIVEKIT_OBSERVER_TOKEN, { autoSubscribe: true, dynacast: false })
  await writeFile(env.MEDIA_LAB_READY_PATH, 'ready\n')
  const deadline = performance.now() + (seconds + 25) * 1000
  if (rejoin) {
    while (frames < 600 && !unsubscribed && performance.now() < deadline)
      await new Promise(resolve => setTimeout(resolve, 50))
    if (frames < 600 || unsubscribed) throw new Error('Publication ended before observer rejoin')
    await room.disconnect()
    await readerTask
    lastAt = 0 // The deliberate offline interval is not a delivery stall.
    ++deliberateRejoins
    // rtc-node Room retains participant bookkeeping after disconnect; a fresh
    // observer session uses a fresh Room, just as a separate client would.
    room = new Room()
    observeRoom(room)
    await room.connect(env.LIVEKIT_URL, env.LIVEKIT_OBSERVER_TOKEN, { autoSubscribe: true, dynacast: false })
  }
  // Local disconnect does not emit TrackUnsubscribed. The terminal event here
  // must come from the publisher removing its track in the joined session.
  const expectedUnsubscribes = 1
  while (unsubscribed < expectedUnsubscribes && performance.now() < deadline)
    await new Promise(resolve => setTimeout(resolve, 50))
  if (unsubscribed !== expectedUnsubscribes) failures.push('Microphone publication did not finish')
} catch (error) { failures.push(String(error)) }
finally { await room.disconnect(); await readerTask; await dispose() }
if (subscribed !== (rejoin ? 2 : 1) || reconnects || frames < 500) failures.push('Microphone reception continuity failed')
const windows = Array.from(samples, (count, index) => ({
  atUnixMs: startedAt + index * 100, samples: count,
  rms: count ? Math.sqrt(energy[index]! / count) : 0,
})).filter(window => window.samples > 0)
const report = { accepted: failures.length === 0, failures, subscribed, unsubscribed, reconnects,
  deliberateRejoins, publicationSid, frames, maximumGapMs, windows }
await writeFile(env.MEDIA_LAB_REPORT_PATH, JSON.stringify(report, null, 2))
console.log(JSON.stringify({ ...report, windows: undefined }))
if (!report.accepted) process.exitCode = 1
