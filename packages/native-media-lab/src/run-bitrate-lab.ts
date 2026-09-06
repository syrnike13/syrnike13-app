import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { mkdtemp, writeFile, readFile, mkdir } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { AccessToken } from 'livekit-server-sdk'
import { Schema } from 'effect'
import { labIpv4Address, startBitrateNetworkShaper } from './bitrate-network-shaper.js'
import { verifyAudioCaptureAge } from './audio-sync-evidence.js'
import { verifyBitrateEvidence } from './bitrate-evidence.js'

const env = Schema.decodeUnknownSync(Schema.Struct({
  MEDIA_LAB_SERVER_EXE: Schema.String, MEDIA_LAB_AUDIO_BIN: Schema.String,
  MEDIA_LAB_AUDIO_REPORT: Schema.String, MEDIA_LAB_AUDIO_DURATION_MS: Schema.String,
  MEDIA_LAB_PLAYOUT_MAX_MS: Schema.optionalKey(Schema.String),
}))(process.env)
const duration = Number(env.MEDIA_LAB_AUDIO_DURATION_MS)
if (!Number.isSafeInteger(duration) || duration < 5000 || duration > 1260_000 || duration % 1000) throw new Error('Invalid duration')
const playoutMaxMs = env.MEDIA_LAB_PLAYOUT_MAX_MS === undefined ? undefined : Number(env.MEDIA_LAB_PLAYOUT_MAX_MS)
if (playoutMaxMs !== undefined && (!Number.isSafeInteger(playoutMaxMs) || playoutMaxMs < 0 || playoutMaxMs > 1000))
  throw new Error('Invalid diagnostic playout delay')
const repository = fileURLToPath(new URL('../../../', import.meta.url))
const provenance = {
  appCommit: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repository, windowsHide: true, encoding: 'utf8' }).trim(),
  dirty: execFileSync('git', ['status', '--porcelain'], { cwd: repository, windowsHide: true, encoding: 'utf8' }).trim().length > 0,
  diagnosticServerPlayoutMaxMs: playoutMaxMs,
  serverBinarySha256: createHash('sha256').update(await readFile(env.MEDIA_LAB_SERVER_EXE)).digest('hex'),
  // Hash the binaries actually loaded, so an unpublished SDK cannot be mistaken
  // for the declared app pin. Hardware/driver and published provenance still
  // belong in the qualification manifest.
  binarySha256: Object.fromEntries(await Promise.all(
    ['screen_audio_lab.exe', 'audio_sync_fixture.exe', 'livekit.dll', 'livekit_ffi.dll'].map(async name =>
      [name, createHash('sha256').update(await readFile(path.join(env.MEDIA_LAB_AUDIO_BIN, name))).digest('hex')]))),
}
const processes: ChildProcess[] = [], directory = await mkdtemp(path.join(os.tmpdir(), 'syrnike-bitrate-'))
const key = `lab_${randomBytes(12).toString('hex')}`, secret = randomBytes(32).toString('hex')
await mkdir(path.dirname(env.MEDIA_LAB_AUDIO_REPORT), { recursive: true })
function start(executable: string, args: string[], overrides: NodeJS.ProcessEnv = {}) {
  const child = spawn(executable, args, { env: { ...process.env, MEDIA_LAB_AUDIO_SCENARIO: 'bitrate', ...overrides }, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
  processes.push(child)
  let stdout = '', stderr = '', overflow = false
  const output = () => stdout + stderr
  const append = (chunk: Buffer, standard: boolean) => {
    if (stdout.length + stderr.length + chunk.length > 8_000_000) { overflow = true; child.kill(); return }
    if (standard) stdout += String(chunk)
    else stderr += String(chunk)
  }
  child.stdout?.on('data', chunk => append(chunk, true))
  child.stderr?.on('data', chunk => append(chunk, false))
  const complete = new Promise<void>((resolve, reject) => {
    child.once('error', reject)
    child.once('close', code => code === 0 && !overflow ? resolve() : reject(new Error(`${path.basename(executable)} exited ${code}; overflow=${overflow}\n${output().slice(-2000)}`)))
  })
  void complete.catch(() => undefined)
  return { child, complete, output, stdout: () => stdout }
}
async function until(predicate: () => boolean | Promise<boolean>, milliseconds: number, message: string) {
  const deadline = performance.now() + milliseconds
  while (performance.now() < deadline) {
    if (await predicate()) return
    await new Promise(resolve => setTimeout(resolve, 50))
  }
  throw new Error(message)
}
async function token(identity: string) {
  const value = new AccessToken(key, secret, { identity, ttl: '30m' })
  value.addGrant({ roomJoin: true, room: 'native-v2-media-lab', canPublish: true, canSubscribe: true })
  return value.toJwt()
}
let startAt = 0
function limit() {
  if (!startAt) return 12_000_000
  const phase = (Date.now() - startAt) % 300_000
  return phase < 30_000 ? 12_000_000 : phase < 60_000 ? 3_000_000 : phase < 90_000 ? 1_250_000 : 12_000_000
}
let shaper: Awaited<ReturnType<typeof startBitrateNetworkShaper>> | undefined
let publisher: ReturnType<typeof start> | undefined, server: ReturnType<typeof start> | undefined
let sampling: ReturnType<typeof setInterval> | undefined
const linkSamples: unknown[] = []
const redact = (value: string) => value.replaceAll(secret, '[redacted]').replaceAll(key, '[redacted]').replace(/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, '[token]')
try {
  const config = path.join(directory, 'livekit.yaml')
  const address = labIpv4Address()
  const playout = playoutMaxMs === undefined ? '' : `room:\n  playout_delay:\n    enabled: true\n    min: 0\n    max: ${playoutMaxMs}\n`
  await writeFile(config, `port: 17990\nbind_addresses: ["127.0.0.1"]\n${playout}rtc:\n  tcp_port: 17991\n  udp_port: 17992\n  node_ip: "${address}"\n  ips:\n    includes: ["${address}/32"]\n  use_external_ip: false\nlogging:\n  level: warn\nkeys:\n  ${key}: ${secret}\n`)
  server = start(env.MEDIA_LAB_SERVER_EXE, ['--config', config])
  await until(async () => { try { return (await fetch('http://127.0.0.1:17990')).ok } catch { return false } }, 10_000, 'SFU startup timeout')
  shaper = await startBitrateNetworkShaper({ serverSignalPort: 17990, serverUdpPort: 17992, signalPort: 17993, udpPort: 17994, limit })
  const ready = path.join(directory, 'observer-ready')
  const measuredEnd = path.join(directory, 'measured-end')
  const observer = start(process.execPath, [fileURLToPath(new URL('./bitrate-observer.js', import.meta.url))], {
    LIVEKIT_URL: 'ws://127.0.0.1:17990', LIVEKIT_OBSERVER_TOKEN: await token('neutral-bitrate-observer'),
    MEDIA_LAB_READY_PATH: ready, MEDIA_LAB_REPORT_PATH: `${env.MEDIA_LAB_AUDIO_REPORT}.receiver.json`,
    MEDIA_LAB_MEASURED_END_PATH: measuredEnd,
  })
  await until(async () => { try { return (await readFile(ready, 'utf8')).startsWith('ready') } catch { return false } }, 10_000, 'Observer startup timeout')
  const fixture = start(path.join(env.MEDIA_LAB_AUDIO_BIN, 'audio_sync_fixture.exe'), [])
  await until(() => fixture.output().includes('AUDIO_FIXTURE_READY'), 5000, 'Fixture startup timeout')
  if (!fixture.child.pid) throw new Error('Missing fixture PID')
  publisher = start(path.join(env.MEDIA_LAB_AUDIO_BIN, 'screen_audio_lab.exe'), [String(fixture.child.pid), String(duration / 1000)], {
    LIVEKIT_URL: 'ws://127.0.0.1:17993', LIVEKIT_PUBLISHER_TOKEN: await token('native-v2-publisher'),
    MEDIA_LAB_MEASURED_END_PATH: measuredEnd,
  })
  await until(() => publisher!.output().includes('SCREEN_AUDIO_READY'), 20_000, 'Publication startup timeout')
  startAt = Date.now()
  sampling = setInterval(() => {
    if (linkSamples.length >= 2600) { publisher?.child.kill(); return }
    linkSamples.push({ atMs: Date.now(), limitBps: limit(), ...shaper!.snapshot() })
    if (linkSamples.length % 60 === 0) {
      const latest = publisher!.stdout().split(/\r?\n/).findLast(line => line.startsWith('BITRATE_SAMPLE '))
      console.log(latest ?? 'Awaiting publisher sample')
    }
  }, 500)
  let timer: ReturnType<typeof setTimeout> | undefined
  const results = await Promise.race([
    Promise.allSettled([publisher.complete, observer.complete]),
    new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('Lab deadline exceeded')), duration + 40_000) }),
  ]).finally(() => clearTimeout(timer))
  const Pulse = Schema.Struct({ atMs: Schema.Number, code: Schema.Number })
  const receiverValue: unknown = JSON.parse(await readFile(`${env.MEDIA_LAB_AUDIO_REPORT}.receiver.json`, 'utf8'))
  const receiver = Schema.decodeUnknownSync(Schema.Struct({ accepted: Schema.Boolean, audio: Schema.Array(Pulse) }))(receiverValue)
  // Diagnostics on stderr must not be spliced into a partial stdout record.
  const lines = publisher.stdout().split(/\r?\n/)
  const references = lines.filter(line => line.startsWith('CODED_AUDIO_CAPTURE '))
    .map(line => Schema.decodeUnknownSync(Pulse)(JSON.parse(line.slice('CODED_AUDIO_CAPTURE '.length))))
  const samples: unknown[] = lines.filter(line => line.startsWith('BITRATE_SAMPLE ')).map(line => JSON.parse(line.slice('BITRATE_SAMPLE '.length)))
  const audioAge = verifyAudioCaptureAge(references, receiver.audio)
  const evidence = verifyBitrateEvidence(samples, receiverValue, duration, startAt)
  const failures = results.flatMap(result => result.status === 'rejected' ? [redact(String(result.reason))] : [])
  failures.push(...evidence.failures)
  if (!receiver.accepted) failures.push('Receiver acceptance failed')
  if (!audioAge.accepted) failures.push('Audio capture age failed')
  if (shaper.snapshot().failure || !shaper.snapshot().rewrites || !shaper.snapshot().deliveredBytes) failures.push('Network link proof failed')
  await writeFile(env.MEDIA_LAB_AUDIO_REPORT, JSON.stringify({ accepted: failures.length === 0, failures, duration, startAt, provenance,
    scenario: '1080p60; repeating 300s: 12Mbps 30s, 3Mbps 30s, 1.25Mbps 30s, 12Mbps 210s; GPU 150-160s',
    evidence, audioAge, references, samples, linkSamples, publisherLog: redact(publisher.output()) }, null, 2))
  console.log(JSON.stringify({ failures, audioAge, sampleCount: samples.length, link: shaper.snapshot() }))
  if (failures.length) process.exitCode = 1
} catch (error) {
  await writeFile(`${env.MEDIA_LAB_AUDIO_REPORT}.failure.json`, JSON.stringify({ error: redact(String(error)), provenance, link: shaper?.snapshot(), publisher: redact(publisher?.output() ?? ''), server: redact(server?.output() ?? '') }, null, 2))
  throw error
} finally {
  clearInterval(sampling)
  for (const child of processes.reverse()) if (child.exitCode === null) child.kill()
  await shaper?.close()
}
