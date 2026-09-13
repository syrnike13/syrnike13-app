import { createHash, randomUUID } from 'node:crypto'
import { createInterface } from 'node:readline'
import WebSocket from 'ws'
import { Room, RoomEvent, TrackKind, TrackSource, VideoStream, AudioStream, dispose } from '@livekit/rtc-node'

// One isolated receiver process, four expected product publications, bounded
// readers and aggregate evidence. Credentials and raw media never enter stdout.
const room = new Room()
const records = new Map()
const readers = new Map()
const tasks = new Set()
const sources = ['camera', 'screen', 'screen_audio', 'microphone']
const publisherUserId = process.env.LIVEKIT_OBSERVER_USER_ID
const acceptsPublisher = participant => publisherUserId ?
  participant.identity.split('|').at(-1) === publisherUserId :
  participant.identity === process.env.LIVEKIT_OBSERVER_PUBLISHER
let active
let terminal = false
let failures = 0
let reconnects = 0
let phase = 'configuration'
let gateway
let heartbeat
const claim = { operation_id: `voice-op-${randomUUID()}`, client_instance_id: randomUUID(),
  connection_epoch: randomUUID(), rtc_engine: 'web' }
const authorityRequest = mode => ({
  type: 'VoiceStateUpdate', nonce: randomUUID(), request: { ...claim, mode },
  channel_id: mode === 'join' ? process.env.VOICE_CHANNEL_ID : null,
  self_mute: true, self_deaf: false, suppress_call_notifications: true,
})

async function reserveAuthority() {
  if (!process.env.VOICE_GATEWAY_URL || !process.env.VOICE_SESSION_TOKEN || !process.env.VOICE_CHANNEL_ID)
    throw new Error('observer_authority_configuration_missing')
  const url = new URL(process.env.VOICE_GATEWAY_URL)
  url.searchParams.set('version', '1')
  url.searchParams.set('format', 'json')
  url.searchParams.set('client', 'web')
  url.searchParams.set('token', process.env.VOICE_SESSION_TOKEN)
  gateway = new WebSocket(url, { maxPayload: 262_144, handshakeTimeout: 15_000 })
  return new Promise((resolve, reject) => {
    let requested = false
    const deadline = setTimeout(() => reject(new Error('observer_authority_deadline')), 15_000)
    const fail = () => {
      clearTimeout(deadline)
      if (!terminal) ++failures
      reject(new Error('observer_authority_failed'))
    }
    const receive = (event, depth = 0) => {
      if (depth > 4) throw new Error('gateway_event_depth')
      if (event.type === 'Bulk') {
        if (!Array.isArray(event.v) || event.v.length > 128) throw new Error('gateway_event_capacity')
        for (const item of event.v) receive(item, depth + 1)
      } else if (event.type === 'Ping') {
        gateway.send(JSON.stringify({ type: 'Pong', data: event.data }))
      } else if (event.type === 'Ready' && !requested) {
        requested = true
        gateway.send(JSON.stringify(authorityRequest('join')))
      } else if (event.type === 'VoiceServerUpdate' && event.operation_id === claim.operation_id) {
        if (event.credential?.connection_epoch !== claim.connection_epoch ||
            event.credential?.client_instance_id !== claim.client_instance_id ||
            typeof event.url !== 'string' || typeof event.credential.token !== 'string')
          throw new Error('observer_authority_mismatch')
        clearTimeout(deadline)
        resolve({ url: event.url, token: event.credential.token })
      } else if (event.type === 'Error') {
        phase = 'gateway_error'
        fail()
      }
    }
    gateway.addEventListener('message', message => {
      try {
        if (typeof message.data !== 'string' || message.data.length > 262_144)
          throw new Error('gateway_message_capacity')
        receive(JSON.parse(message.data))
      } catch { fail() }
    })
    gateway.addEventListener('error', fail)
    gateway.addEventListener('close', fail)
    heartbeat = setInterval(() => {
      if (gateway.readyState === WebSocket.OPEN)
        gateway.send(JSON.stringify({ type: 'Ping', data: Date.now() }))
    }, 20_000)
  })
}
const sourceName = source => ({
  [TrackSource.SOURCE_CAMERA]: 'camera',
  [TrackSource.SOURCE_SCREENSHARE]: 'screen',
  [TrackSource.SOURCE_SCREENSHARE_AUDIO]: 'screen_audio',
  [TrackSource.SOURCE_MICROPHONE]: 'microphone',
})[source]
const emit = value => process.stdout.write(`PRODUCT_OBSERVER_RESULT ${JSON.stringify(value)}\n`)
const snapshot = () => [...records.values()].map(record => ({
  source: record.source, alias: record.alias, frames: record.frames,
  ageMs: record.lastAt ? Date.now() - record.lastAt : null,
  unsubscribed: record.unsubscribed,
  maximumAudioFrameRms: record.maximumAudioFrameRms,
  audioWindows: record.audioWindows.map(window => ({
    atUnixMs: window.atUnixMs, samples: window.samples,
    rms: Math.sqrt(window.energy / Math.max(1, window.samples)),
  })),
}))

async function closeGateway() {
  if (!gateway || gateway.readyState === WebSocket.CLOSED) return false
  let forced = false
  await new Promise((resolve, reject) => {
    const terminate = setTimeout(() => { forced = true; gateway.terminate() }, 1_000)
    const deadline = setTimeout(() => reject(new Error('observer_gateway_close_deadline')), 2_000)
    gateway.once('close', () => {
      clearTimeout(terminate)
      clearTimeout(deadline)
      resolve()
    })
    gateway.close()
  })
  return forced
}

async function consume(track, record) {
  const stream = track.kind === TrackKind.KIND_VIDEO ? new VideoStream(track) :
    new AudioStream(track, { sampleRate: 48_000, numChannels: 1, frameSizeMs: 10 })
  const reader = stream.getReader()
  readers.set(track.sid, reader)
  try {
    for (;;) {
      const item = await reader.read()
      if (item.done) return
      const now = Date.now()
      if (active && record.lastAt)
        active.maximumGapMs = Math.max(active.maximumGapMs, now - record.lastAt)
      record.lastAt = now
      ++record.frames
      if (track.kind === TrackKind.KIND_AUDIO) {
        const atUnixMs = Math.floor(now / 100) * 100
        let window = record.audioWindows.at(-1)
        if (window?.atUnixMs !== atUnixMs) {
          window = { atUnixMs, samples: 0, energy: 0 }
          record.audioWindows.push(window)
          if (record.audioWindows.length > 32) record.audioWindows.shift()
        }
        let frameEnergy = 0
        for (const sample of item.value.data) frameEnergy += sample * sample
        window.energy += frameEnergy
        window.samples += item.value.data.length
        record.maximumAudioFrameRms = Math.max(record.maximumAudioFrameRms,
          Math.sqrt(frameEnergy / Math.max(1, item.value.data.length)))
      }
    }
  } catch { if (!terminal && !record.unsubscribed) ++failures }
  finally { readers.delete(track.sid); reader.releaseLock() }
}

room.on(RoomEvent.TrackSubscribed, (track, publication, participant) => {
  if (!acceptsPublisher(participant)) return
  const source = sourceName(publication.source)
  if (!source || records.has(publication.sid) || records.size >= 8 || tasks.size >= 8) {
    ++failures
    return
  }
  const record = {
    source, alias: createHash('sha256').update(publication.sid).digest('hex').slice(0, 12),
    frames: 0, lastAt: 0, unsubscribed: false,
    audioWindows: [], maximumAudioFrameRms: 0,
  }
  records.set(publication.sid, record)
  const task = consume(track, record).catch(() => { ++failures })
  tasks.add(task)
  void task.finally(() => tasks.delete(task))
})
room.on(RoomEvent.TrackUnsubscribed, (track, publication, participant) => {
  if (!acceptsPublisher(participant)) return
  const record = records.get(publication.sid)
  if (record) record.unsubscribed = true
  void readers.get(track.sid)?.cancel().catch(() => {})
  // Recovery mode follows only this test user's replacement publications.
  // Strict continuity mode retains retired records so replacement fails it.
  if (publisherUserId) records.delete(publication.sid)
})
room.on(RoomEvent.Reconnecting, () => { ++reconnects })
room.on(RoomEvent.Disconnected, () => { if (!terminal) ++failures })

try {
  if ((!process.env.LIVEKIT_OBSERVER_PUBLISHER && !publisherUserId) ||
      (process.env.LIVEKIT_OBSERVER_PUBLISHER && publisherUserId))
    throw new Error('observer_fixture_configuration_missing')
  phase = 'authority'
  const lease = await reserveAuthority()
  phase = 'rtc_connect'
  await room.connect(lease.url, lease.token, { autoSubscribe: true, dynacast: false })
  phase = 'commands'
  emit({ event: 'ready' })
  const commands = createInterface({ input: process.stdin, crlfDelay: Infinity })
  for await (const command of commands) {
    if (command === 'stop') break
    if (command === 'snapshot') {
      emit({ event: 'snapshot', publications: snapshot(), failures, reconnects })
      continue
    }
    if (command === 'begin' && !active) {
      const before = snapshot()
      if (before.length !== 4 || !sources.every(source => before.filter(record =>
        record.source === source && !record.unsubscribed && record.frames >= 10 && record.ageMs < 1_500).length === 1))
        throw new Error('observer_baseline_not_ready')
      active = { before, maximumGapMs: 0 }
      emit({ event: 'begin', publications: before })
      continue
    }
    if (command === 'finish' && active) {
      const after = snapshot()
      const progress = active.before.map(before => {
        const current = after.find(record => record.alias === before.alias)
        return current && !current.unsubscribed ? current.frames - before.frames : 0
      })
      const passed = failures === 0 && reconnects === 0 && after.length === 4 &&
        Math.min(...progress) > 0 && active.maximumGapMs <= 1_500 &&
        after.every(record => record.ageMs !== null && record.ageMs <= 1_500)
      emit({ event: 'finish', passed, publications: after, minimumFrameProgress: Math.min(...progress),
        maximumGapMs: active.maximumGapMs, failures, reconnects })
      active = undefined
      continue
    }
    throw new Error('observer_command_out_of_order')
  }
} catch (error) {
  const reason = /^observer_[a-z_]+$/.test(error.message) ? error.message : 'neutral_observer_failed'
  emit({ event: 'failed', failure: reason, phase })
  process.exitCode = 1
} finally {
  terminal = true
  clearInterval(heartbeat)
  if (gateway?.readyState === WebSocket.OPEN) gateway.send(JSON.stringify(authorityRequest('disconnect')))
  await Promise.all([...readers.values()].map(reader => reader.cancel().catch(() => {})))
  await Promise.all(tasks)
  await room.disconnect()
  const gatewayCloseForced = await closeGateway()
  await dispose()
  process.stdin.destroy()
  emit({ event: 'cleanup', phase: 'complete', gatewayCloseForced })
}
