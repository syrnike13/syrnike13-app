import { spawn, type ChildProcess } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { mkdtemp, writeFile, readFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { AccessToken } from 'livekit-server-sdk'
import { Schema } from 'effect'
import { verifyAudioCaptureAge } from './audio-sync-evidence.js'

const env = Schema.decodeUnknownSync(Schema.Struct({
  MEDIA_LAB_SERVER_EXE: Schema.String,
  MEDIA_LAB_AUDIO_BIN: Schema.String,
  MEDIA_LAB_AUDIO_REPORT: Schema.String,
  MEDIA_LAB_AUDIO_DURATION_MS: Schema.String,
}))(process.env)
const duration = Number(env.MEDIA_LAB_AUDIO_DURATION_MS)
if (!Number.isSafeInteger(duration) || duration < 5000 || duration > 660_000 || duration % 1000) throw new Error('Invalid audio duration')
const processes: ChildProcess[] = []
const directory = await mkdtemp(path.join(os.tmpdir(), 'syrnike-screen-audio-'))
const key = `audio_${randomBytes(12).toString('hex')}`, secret = randomBytes(32).toString('hex')
const url = 'ws://127.0.0.1:7886'
function start(executable: string, args: string[], overrides: NodeJS.ProcessEnv = {}) {
  const child = spawn(executable, args, { env: { ...process.env, ...overrides }, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
  processes.push(child)
  let output = ''
  child.stdout?.on('data', chunk => { output = (output + String(chunk)).slice(-1_000_000) })
  child.stderr?.on('data', chunk => { output = (output + String(chunk)).slice(-1_000_000) })
  const complete = new Promise<void>((resolve, reject) => {
    child.once('error', reject)
    child.once('close', code => code === 0 ? resolve() : reject(new Error(`${path.basename(executable)} exited ${code}\n${output.slice(-2000)}`)))
  })
  void complete.catch(() => undefined)
  return { child, complete, output: () => output }
}
async function until(predicate: () => Promise<boolean> | boolean, milliseconds: number, message: string) {
  const end = performance.now() + milliseconds
  while (performance.now() < end) {
    if (await predicate()) return
    await new Promise(resolve => setTimeout(resolve, 50))
  }
  throw new Error(message)
}
async function token(identity: string) {
  const token = new AccessToken(key, secret, { identity, ttl: '30m' })
  token.addGrant({ roomJoin: true, room: 'native-v2-media-lab', canPublish: true, canSubscribe: true })
  return token.toJwt()
}
let server: ReturnType<typeof start> | undefined, publisher: ReturnType<typeof start> | undefined, fixture: ReturnType<typeof start> | undefined
let targetStopTimer: ReturnType<typeof setTimeout> | undefined
let endpointProof: ReturnType<typeof start> | undefined
try {
  const config = path.join(directory, 'livekit.yaml')
  await writeFile(config, `port: 7886\nbind_addresses: ["127.0.0.1"]\nrtc:\n  tcp_port: 7887\n  udp_port: 7888\n  node_ip: "127.0.0.1"\n  use_external_ip: false\nlogging:\n  level: ${process.env.MEDIA_LAB_DIAGNOSTIC_LOGS === 'true' ? 'debug' : 'warn'}\nkeys:\n  ${key}: ${secret}\n`)
  server = start(env.MEDIA_LAB_SERVER_EXE, ['--config', config])
  await until(async () => { try { return (await fetch('http://127.0.0.1:7886')).ok } catch { return false } }, 10_000, 'SFU startup timeout')
  const ready = path.join(directory, 'observer-ready')
  const observer = start(process.execPath, [fileURLToPath(new URL('./screen-audio-observer.js', import.meta.url))], {
    LIVEKIT_URL: url, LIVEKIT_OBSERVER_TOKEN: await token('neutral-audio-observer'),
    MEDIA_LAB_READY_PATH: ready, MEDIA_LAB_REPORT_PATH: env.MEDIA_LAB_AUDIO_REPORT,
  })
  await until(async () => { try { return (await readFile(ready, 'utf8')).startsWith('ready') } catch { return false } }, 10_000, 'Observer startup timeout')
  fixture = start(path.join(env.MEDIA_LAB_AUDIO_BIN, 'audio_sync_fixture.exe'), process.env.MEDIA_LAB_AUDIO_SCENARIO === 'source-close' ? ['0', '0', 'keep-audio'] : [])
  await until(() => fixture!.output().includes('AUDIO_FIXTURE_READY'), 5000, 'Fixture startup timeout')
  if (!fixture.child.pid) throw new Error('Fixture PID unavailable')
  if (process.env.MEDIA_LAB_AUDIO_SCENARIO === 'system') {
    const reference = start(path.join(env.MEDIA_LAB_AUDIO_BIN, 'remote_audio_reference.exe'), [String(duration / 1000 + 20)], {
      LIVEKIT_URL: url, LIVEKIT_REFERENCE_TOKEN: await token('remote-audio-reference'),
    })
    await until(() => reference.output().includes('REMOTE_AUDIO_REFERENCE_READY'), 10_000, 'Remote voice reference startup timeout')
  }
  if (process.env.MEDIA_LAB_AUDIO_SCENARIO === 'process-isolation') {
    const foreign = start(path.join(env.MEDIA_LAB_AUDIO_BIN, 'audio_sync_fixture.exe'), ['8', '500'])
    await until(() => foreign.output().includes('AUDIO_FIXTURE_READY'), 5000, 'Foreign fixture startup timeout')
  }
  const audioTarget = process.env.MEDIA_LAB_AUDIO_SCENARIO === 'audio-loss'
    ? start(path.join(env.MEDIA_LAB_AUDIO_BIN, 'audio_sync_fixture.exe'), ['8']) : undefined
  if (audioTarget) await until(() => audioTarget.output().includes('AUDIO_FIXTURE_READY'), 5000, 'Audio target startup timeout')
  publisher = start(path.join(env.MEDIA_LAB_AUDIO_BIN, 'screen_audio_lab.exe'), [String(fixture.child.pid), String(duration / 1000)], {
    LIVEKIT_URL: url, LIVEKIT_PUBLISHER_TOKEN: await token('native-v2-publisher'),
    MEDIA_LAB_AUDIO_TARGET_PID: audioTarget?.child.pid ? String(audioTarget.child.pid) : undefined,
  })
  if (audioTarget) {
    await until(() => publisher!.output().includes('SCREEN_AUDIO_READY'), 15_000, 'Loss fixture publication startup timeout')
    targetStopTimer = setTimeout(() => audioTarget.child.kill(), 8000)
  }
  if (process.env.MEDIA_LAB_AUDIO_SCENARIO === 'default-output') {
    const helper = process.env.MEDIA_LAB_ENDPOINT_PROOF_HELPER, target = process.env.MEDIA_LAB_ENDPOINT_PROOF_TARGET
    if (!helper || !target) throw new Error('Default-output proof requires explicit external helper and endpoint')
    await until(() => publisher!.output().includes('SCREEN_AUDIO_READY'), 15_000, 'Default-output publication startup timeout')
    await new Promise(resolve => setTimeout(resolve, 8000))
    endpointProof = start(helper, [target])
  }
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    await Promise.race([Promise.all([publisher.complete, observer.complete, ...(endpointProof ? [endpointProof.complete] : [])]), new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('Audio lab deadline exceeded')), duration + 40_000)
    })])
  } finally { clearTimeout(timer) }
  if (endpointProof) {
    if (!endpointProof.output().includes('DEFAULT_ENDPOINT_CHANGED') || !endpointProof.output().includes('DEFAULT_ENDPOINT_RESTORED'))
      throw new Error('Default endpoint mutation/restoration was not verified')
    console.log(endpointProof.output())
  }
  const Pulse = Schema.Struct({ atMs: Schema.Number, code: Schema.Number, rms: Schema.optionalKey(Schema.Number) })
  const observed = Schema.decodeUnknownSync(Schema.Struct({
    accepted: Schema.Boolean, audio: Schema.Array(Pulse), measuredVideoFrames: Schema.Number, p95VideoAgeMs: Schema.Number,
  }))(JSON.parse(await readFile(env.MEDIA_LAB_AUDIO_REPORT, 'utf8')))
  const references = publisher.output().split(/\r?\n/).filter(line => line.startsWith('CODED_AUDIO_CAPTURE '))
    .map(line => Schema.decodeUnknownSync(Pulse)(JSON.parse(line.slice('CODED_AUDIO_CAPTURE '.length))))
  const audioAge = verifyAudioCaptureAge(references, observed.audio)
  await writeFile(`${env.MEDIA_LAB_AUDIO_REPORT}.capture-age.json`, JSON.stringify({ audioAge, references, videoFrames: observed.measuredVideoFrames, videoAgeP95Ms: observed.p95VideoAgeMs }, null, 2))
  if (!audioAge.accepted || observed.measuredVideoFrames < 100 || observed.p95VideoAgeMs > 150)
    throw new Error('Capture-to-observer audio/video age evidence failed')
  console.log(publisher.output())
  console.log(`Audio observer report: ${env.MEDIA_LAB_AUDIO_REPORT}`)
} catch (error) {
  await writeFile(`${env.MEDIA_LAB_AUDIO_REPORT}.failure.json`, JSON.stringify({ error: String(error), fixture: fixture?.output(), fixtureExit: fixture?.child.exitCode, publisher: publisher?.output(), server: server?.output() }, null, 2))
  throw error
} finally {
  clearTimeout(targetStopTimer)
  // The external opt-in helper owns restoration. Do not terminate it in the
  // middle of a device transition when another test process fails.
  if (endpointProof) await endpointProof.complete.catch(() => undefined)
  for (const child of processes.reverse()) {
    if (child.exitCode !== null || child.signalCode !== null) continue
    const closed = new Promise<void>(resolve => child.once('close', () => resolve()))
    child.kill(); await closed
  }
}
