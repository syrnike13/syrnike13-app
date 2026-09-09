import { spawn } from 'node:child_process'
import { randomBytes, createHash } from 'node:crypto'
import { mkdtemp, mkdir, writeFile, readFile, readdir, symlink, unlink, rm } from 'node:fs/promises'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import { AccessToken } from 'livekit-server-sdk'
import { Room, RoomEvent, TrackKind, TrackSource, VideoStream, AudioStream, dispose } from '@livekit/rtc-node'
import { createRendererFaultEvidence } from './renderer-fault-evidence.mjs'

const root = path.resolve(import.meta.dirname, '../../..')
const desktopRoot = path.join(root, 'apps/desktop')
const desktopRequire = createRequire(path.join(desktopRoot, 'package.json'))
const serverPath = process.env.MEDIA_LAB_SERVER_EXE
if (!serverPath || !path.isAbsolute(serverPath)) throw Error('MEDIA_LAB_SERVER_EXE must name the project LiveKit server')
const output = path.resolve(process.env.MEDIA_PRODUCT_REPORT || path.join(root, 'packages/native-media-lab/artifacts/product-smoke.json'))
const temporary = await mkdtemp(path.join(os.tmpdir(), 'syrnike-product-'))
const children = []
const room = new Room()
const readers = new Map()
const tasks = []
const publications = new Map()
const phaseEvidence = []
const rendererFaultMode = process.env.MEDIA_PRODUCT_RENDERER_FAULTS === '1'
const rendererFaultEvidence = createRendererFaultEvidence()
let reconnects = 0
let readerFailures = 0
let terminal = false
let publisherReport
let accepted = false
const key = randomBytes(12).toString('hex')
const secret = randomBytes(32).toString('hex')
const url = 'ws://127.0.0.1:17880'
const sourceName = source => source === TrackSource.SOURCE_CAMERA ? 'camera' :
  source === TrackSource.SOURCE_SCREENSHARE ? 'screen' :
  source === TrackSource.SOURCE_SCREENSHARE_AUDIO ? 'screen_audio' : 'microphone'

function launch(executable, args, extraEnv = {}) {
  const child = spawn(executable, args, { cwd: desktopRoot, windowsHide: true,
    env: { ...process.env, ...extraEnv }, stdio: ['ignore', 'pipe', 'pipe'] })
  const done = new Promise(resolve => {
    child.once('error', () => resolve(1))
    child.once('close', code => resolve(code ?? 1))
  })
  children.push({ child, done })
  // SDK diagnostics are not copied into evidence: they may include connection
  // credentials. Product phases and bounded numeric receiver data are sufficient.
  child.stderr.on('data', () => {})
  return { child, done }
}
async function until(predicate, label, timeout = 10_000) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    if (await predicate()) return
    await new Promise(resolve => setTimeout(resolve, 50))
  }
  throw Error(label)
}
async function token(identity) {
  const value = new AccessToken(key, secret, { identity, ttl: rendererFaultMode ? '30m' : '10m' })
  value.addGrant({ roomJoin: true, room: 'native-product-check', canPublish: true, canSubscribe: true })
  return value.toJwt()
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
      if (record.lastAt) {
        record.maximumGapMs = Math.max(record.maximumGapMs, now - record.lastAt)
        rendererFaultEvidence.observeGap(now - record.lastAt)
      }
      record.lastAt = now
      ++record.frames
      if (track.kind === TrackKind.KIND_VIDEO) {
        const { width, height } = item.value.frame
        if (width > 8 && height > 8) {
          record.width = width
          record.height = height
        }
      } else {
        for (const sample of item.value.data) {
          record.energy += sample * sample
          ++record.samples
        }
      }
    }
  } catch { if (!terminal && !record.unsubscribed) ++readerFailures }
  finally { readers.delete(track.sid); reader.releaseLock() }
}
room.on(RoomEvent.TrackSubscribed, (track, publication, participant) => {
  if (participant.identity !== 'product-publisher') return
  if (publications.size >= 8) { ++readerFailures; return }
  const record = {
    source: sourceName(publication.source), alias: createHash('sha256').update(publication.sid).digest('hex').slice(0, 12),
    frames: 0, samples: 0, energy: 0, lastAt: 0, maximumGapMs: 0, unsubscribed: false,
  }
  publications.set(publication.sid, record)
  tasks.push(consume(track, record))
})
room.on(RoomEvent.TrackUnsubscribed, (track, publication, participant) => {
  if (participant.identity !== 'product-publisher') return
  const record = publications.get(publication.sid)
  if (record) record.unsubscribed = true
  void readers.get(track.sid)?.cancel().catch(() => {})
})
room.on(RoomEvent.Reconnecting, () => { ++reconnects })
try {
  const config = path.join(temporary, 'livekit.yaml')
  await writeFile(config, `port: 17880\nbind_addresses: [127.0.0.1]\nrtc:\n  tcp_port: 17881\n  udp_port: 17882\n  node_ip: 127.0.0.1\n  use_external_ip: false\nlogging:\n  level: warn\nkeys:\n  ${key}: ${secret}\n`)
  const server = launch(serverPath, ['--config', config])
  await until(async () => {
    if (server.child.exitCode !== null) throw Error('isolated_server_exited')
    try { return (await fetch('http://127.0.0.1:17880')).ok } catch { return false }
  }, 'isolated_server_deadline')
  await room.connect(url, await token('product-observer'), { autoSubscribe: true, dynacast: false })
  const toneReady = path.join(temporary, 'tone-ready')
  const toneStop = path.join(temporary, 'tone-stop')
  const audioFixture = process.env.MEDIA_PRODUCT_AUDIO_FIXTURE
  if (audioFixture) {
    if (!path.isAbsolute(audioFixture)) throw Error('Audio fixture must be an absolute path')
    const fixture = launch(audioFixture, [])
    let ready = false
    fixture.child.stdout.on('data', chunk => { if (String(chunk).includes('AUDIO_FIXTURE_READY ')) ready = true })
    await until(() => ready, 'foreign_audio_deadline')
  } else {
    launch('powershell.exe', ['-NoProfile', '-File', path.join(root, 'packages/native-media-lab/scripts/foreign-media-tone.ps1'),
      '-ReadyPath', toneReady, '-StopPath', toneStop])
    await until(async () => { try { await readFile(toneReady); return true } catch { return false } }, 'foreign_audio_deadline')
  }
  const smokeApp = path.join(temporary, 'app')
  await mkdir(smokeApp)
  await symlink(path.join(desktopRoot, 'out'), path.join(smokeApp, 'out'), 'junction')
  await writeFile(path.join(smokeApp, 'package.json'), JSON.stringify({
    name: 'syrnike-product-check', version: (await readFile(path.join(root, 'VERSION'), 'utf8')).trim(),
    main: path.join(desktopRoot, 'out/smoke/media-product-smoke.cjs'),
  }))
  const publisherPath = path.join(temporary, 'publisher.json')
  const publisher = launch(desktopRequire('electron'), [smokeApp], {
    LIVEKIT_URL: url, LIVEKIT_PUBLISHER_TOKEN: await token('product-publisher'),
    MEDIA_PRODUCT_PROFILE: path.join(temporary, 'profile'), MEDIA_PRODUCT_REPORT: publisherPath,
    SYRNIKE_NATIVE_MEDIA_DIAGNOSTICS: '1', SYRNIKE_NATIVE_DIAGNOSTIC_ROOT_DIR: path.join(temporary, 'diagnostics'),
  })
  let stdout = ''
  publisher.child.stdout.on('data', chunk => {
    stdout = (stdout + String(chunk)).slice(-32_768)
    for (;;) {
      const end = stdout.indexOf('\n')
      if (end < 0) break
      const line = stdout.slice(0, end).trim()
      stdout = stdout.slice(end + 1)
      if (rendererFaultMode && line.startsWith('MEDIA_PRODUCT_RENDERER_FAULT ')) {
        try {
          const event = JSON.parse(line.slice('MEDIA_PRODUCT_RENDERER_FAULT '.length))
          rendererFaultEvidence.record(event, [...publications.values()])
          if (event.event === 'completed' && (event.iteration + 1) % 10 === 0) console.log(line)
        } catch { rendererFaultEvidence.record(null, []) }
        continue
      }
      if (!line.startsWith('MEDIA_PRODUCT_PHASE ') || phaseEvidence.length >= 32) continue
      const phase = JSON.parse(line.slice('MEDIA_PRODUCT_PHASE '.length))
      phaseEvidence.push({ ...phase, receiver: [...publications.values()].map(value => ({
        source: value.source, alias: value.alias, frames: value.frames, unsubscribed: value.unsubscribed,
        samples: value.samples, energy: value.energy,
      })) })
      console.log(line)
    }
  })
  let publisherTimedOut = false
  const deadline = setTimeout(() => { publisherTimedOut = true; publisher.child.kill() }, rendererFaultMode ? 900_000 : 90_000)
  const exitCode = await publisher.done
  clearTimeout(deadline)
  await writeFile(toneStop, 'stop')
  try { publisherReport = JSON.parse(await readFile(publisherPath, 'utf8')) }
  catch { publisherReport = { accepted: false, failure: publisherTimedOut ? 'publisher_deadline' : 'publisher_report_missing' } }
  const diagnostics = []
  const diagnosticRoot = path.join(temporary, 'diagnostics')
  // Preserve only numeric metrics and bounded symbolic values from product logs.
  // In particular, never copy session metadata, messages, paths or credentials.
  function evidence(value) {
    if (typeof value === 'number' || typeof value === 'boolean' || value === null) return value
    if (typeof value === 'string') return /^[a-z][a-z0-9_-]{0,79}$/.test(value) ? value : undefined
    if (Array.isArray(value)) return value.slice(0, 16).filter(item =>
      item && typeof item.name === 'string' && /^[a-z_]{1,64}$/.test(item.name) && Number.isFinite(item.value))
      .map(item => ({ name: item.name, value: item.value }))
    if (!value || typeof value !== 'object') return undefined
    return Object.fromEntries(Object.entries(value).filter(([key]) =>
      !/token|secret|credential|identity|handle|path|message|label|name|run_id/i.test(key))
      .map(([key, item]) => [key, evidence(item)]).filter(([, item]) => item !== undefined))
  }
  const diagnosticFiles = await readdir(diagnosticRoot, { recursive: true, withFileTypes: true })
    .catch(error => { if (error.code === 'ENOENT') return []; throw error })
  for (const entry of diagnosticFiles) {
    if (!entry.isFile() || !entry.name.endsWith('.jsonl')) continue
    const contents = await readFile(path.join(entry.parentPath, entry.name), 'utf8')
    for (const line of contents.split('\n')) {
      if (!line.trim() || diagnostics.length >= 4096) continue
      const record = JSON.parse(line)
      diagnostics.push({ timestamp_ms: record.timestamp_ms, event: evidence(record.event), data: evidence(record.data?.payload) })
    }
  }
  await new Promise(resolve => setTimeout(resolve, 300))
  const before = phaseEvidence.find(phase => phase.name === 'muted_with_video')
  const after = phaseEvidence.find(phase => phase.name === 'renderer_reloaded')
  const stableVideo = ['screen', 'camera'].every(source => {
    if (source === 'camera' && !publisherReport.devices?.camera) return false
    const first = before?.receiver.find(value => value.source === source)
    const second = after?.receiver.find(value => value.source === source)
    return first && second && first.alias === second.alias && second.frames > first.frames && !second.unsubscribed
  })
  const sourcesReceived = ['microphone', 'screen', 'screen_audio', 'camera'].every(source =>
    [...publications.values()].some(value => value.source === source && value.frames >= 10))
  const audioSignal = [...publications.values()].some(value => value.source === 'screen_audio' &&
    value.samples > 0 && Math.sqrt(value.energy / value.samples) > 10)
  const audioBeforeDeafen = phaseEvidence.find(phase => phase.name === 'deafened')?.receiver.find(value => value.source === 'screen_audio')
  const audioAfterDeafen = phaseEvidence.find(phase => phase.name === 'deafened_with_screen_audio')?.receiver.find(value => value.source === 'screen_audio')
  const audioSurvivesDeafen = Boolean(audioBeforeDeafen && audioAfterDeafen &&
    audioBeforeDeafen.alias === audioAfterDeafen.alias && audioAfterDeafen.samples > audioBeforeDeafen.samples &&
    Math.sqrt((audioAfterDeafen.energy - audioBeforeDeafen.energy) / (audioAfterDeafen.samples - audioBeforeDeafen.samples)) > 10)
  const rendererFaults = rendererFaultEvidence.result()
  const rendererFaultsPassed = !rendererFaultMode || (rendererFaults.passed &&
    publisherReport.rendererFaults?.length === 2 && rendererFaults.rows.every(row =>
      publisherReport.rendererFaults.filter(value => value.id === row.id && value.passed === 100 && value.required === 100).length === 1))
  accepted = exitCode === 0 && publisherReport.accepted && stableVideo && sourcesReceived && audioSignal && audioSurvivesDeafen && readerFailures === 0 && reconnects === 0 && rendererFaultsPassed
  await mkdir(path.dirname(output), { recursive: true })
  await writeFile(output, JSON.stringify({ accepted, publisher: publisherReport, phaseEvidence, diagnostics,
    rendererFaults: rendererFaultMode ? rendererFaults : undefined,
    remainingFaultEvidence: rendererFaultMode ? ['resource-retirement', 'voice-director-and-backend-authority',
      'renderer-release-stall', 'utility-replay', 'combined-faults', 'other-build-configurations'] : undefined,
    receiver: { reconnects, readerFailures, stableVideo, sourcesReceived, audioSignal, audioSurvivesDeafen,
      publications: [...publications.values()].map(({ energy, samples, ...value }) => ({
        ...value, samples, rms: samples ? Math.sqrt(energy / samples) : 0,
      })) },
    serverBinarySha256: createHash('sha256').update(await readFile(serverPath)).digest('hex'),
    audioFixtureSha256: audioFixture ? createHash('sha256').update(await readFile(audioFixture)).digest('hex') : undefined,
  }, null, 2))
  console.log(JSON.stringify({ accepted, publisherFailure: publisherReport.failure, stableVideo, sourcesReceived, audioSignal, audioSurvivesDeafen, readerFailures, reconnects }))
  process.exitCode = accepted ? 0 : 1
} finally {
  terminal = true
  await Promise.all([...readers.values()].map(reader => reader.cancel().catch(() => {})))
  await room.disconnect()
  await Promise.all(tasks)
  await dispose()
  for (const { child } of children.toReversed()) if (child.exitCode === null) child.kill()
  await Promise.all(children.map(({ done }) => done))
  if (!path.resolve(temporary).startsWith(path.join(os.tmpdir(), 'syrnike-product-'))) throw Error('Unsafe temporary path')
  await unlink(path.join(temporary, 'app/out')).catch(error => { if (error.code !== 'ENOENT') throw error })
  await rm(temporary, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
}
