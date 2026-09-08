import { spawn, type ChildProcess } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { AccessToken } from 'livekit-server-sdk'
import { Schema } from 'effect'

const env = Schema.decodeUnknownSync(Schema.Struct({
  MEDIA_LAB_SERVER_EXE: Schema.String, MEDIA_LAB_AUDIO_BIN: Schema.String,
  MEDIA_LAB_MICROPHONE_REPORT: Schema.String, MEDIA_LAB_MICROPHONE_SECONDS: Schema.String,
  MEDIA_LAB_MICROPHONE_INPUT: Schema.optional(Schema.String),
  MEDIA_LAB_MICROPHONE_DEVICE_LOSS: Schema.optional(Schema.Literal('1')),
}))(process.env)
const seconds = Number(env.MEDIA_LAB_MICROPHONE_SECONDS)
if (!Number.isInteger(seconds) || seconds < 15 || seconds > 1800) throw new Error('Invalid microphone duration')
const input = env.MEDIA_LAB_MICROPHONE_INPUT === undefined ? undefined : Number(env.MEDIA_LAB_MICROPHONE_INPUT)
if (input !== undefined && (!Number.isInteger(input) || input < 1 || input > 512)) throw new Error('Invalid microphone input ID')
const deviceLoss = env.MEDIA_LAB_MICROPHONE_DEVICE_LOSS === '1'
if (deviceLoss && (input === undefined || seconds < 30)) throw new Error('Device-loss proof requires an explicit input and at least 30 seconds')
const directory = await mkdtemp(path.join(os.tmpdir(), 'syrnike-microphone-'))
const processes: ChildProcess[] = []
const key = `mic_${randomBytes(12).toString('hex')}`, secret = randomBytes(32).toString('hex')
const url = 'ws://127.0.0.1:7886'
function start(executable: string, args: string[], overrides: NodeJS.ProcessEnv = {}, progress = false) {
  const child = spawn(executable, args, { env: { ...process.env, ...overrides }, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
  processes.push(child)
  let output = ''
  child.stdout?.on('data', chunk => {
    output = (output + String(chunk)).slice(-1_000_000)
    if (progress) for (const line of String(chunk).split(/\r?\n/)) {
      if (line.startsWith('MICROPHONE_')) console.log(line)
    }
  })
  child.stderr?.on('data', chunk => { output = (output + String(chunk)).slice(-1_000_000) })
  const complete = new Promise<void>((resolve, reject) => {
    child.once('error', reject)
    child.once('close', code => code === 0 ? resolve() : reject(new Error(`${path.basename(executable)} exited ${code}\n${output.slice(-2000)}`)))
  })
  void complete.catch(() => undefined)
  return { complete, output: () => output }
}
async function until(predicate: () => Promise<boolean>, ms: number, message: string) {
  const deadline = performance.now() + ms
  while (performance.now() < deadline) {
    if (await predicate()) return
    await new Promise(resolve => setTimeout(resolve, 50))
  }
  throw new Error(message)
}
async function token(identity: string) {
  const value = new AccessToken(key, secret, { identity, ttl: '1h' })
  value.addGrant({ roomJoin: true, room: 'native-v2-media-lab', canPublish: true, canSubscribe: true })
  return value.toJwt()
}
let publisher: ReturnType<typeof start> | undefined
try {
  const config = path.join(directory, 'livekit.yaml')
  await writeFile(config, `port: 7886\nbind_addresses: ["127.0.0.1"]\nrtc:\n  tcp_port: 7887\n  udp_port: 7888\n  node_ip: "127.0.0.1"\n  use_external_ip: false\nlogging:\n  level: warn\nkeys:\n  ${key}: ${secret}\n`)
  start(env.MEDIA_LAB_SERVER_EXE, ['--config', config])
  await until(async () => { try { return (await fetch('http://127.0.0.1:7886')).ok } catch { return false } }, 10_000, 'SFU startup timeout')
  const ready = path.join(directory, 'observer-ready')
  const observer = start(process.execPath, [fileURLToPath(new URL('./microphone-observer.js', import.meta.url))], {
    LIVEKIT_URL: url, LIVEKIT_OBSERVER_TOKEN: await token('neutral-microphone-observer'),
    MEDIA_LAB_READY_PATH: ready, MEDIA_LAB_REPORT_PATH: env.MEDIA_LAB_MICROPHONE_REPORT,
  })
  await until(async () => { try { return (await readFile(ready, 'utf8')).startsWith('ready') } catch { return false } }, 10_000, 'Observer startup timeout')
  const publisherArgs = [deviceLoss ? 'microphone-device-loss' : 'microphone-publication', String(seconds),
    ...(input === undefined ? [] : ['--input', String(input)])]
  publisher = start(path.join(env.MEDIA_LAB_AUDIO_BIN, 'media_lab.exe'), publisherArgs, {
    LIVEKIT_URL: url, LIVEKIT_PUBLISHER_TOKEN: await token('native-v2-publisher'),
  }, true)
  await Promise.race([
    Promise.all([publisher.complete, observer.complete]),
    new Promise<never>((_, reject) => { const timeout = setTimeout(() => reject(new Error('Microphone lab deadline')), (seconds + 40) * 1000); timeout.unref() }),
  ])
  const Phase = Schema.Struct({ name: Schema.String, atUnixMs: Schema.Number })
  const phases = publisher.output().split(/\r?\n/).filter(line => line.startsWith('MICROPHONE_PHASE '))
    .map(line => Schema.decodeUnknownSync(Phase)(JSON.parse(line.slice('MICROPHONE_PHASE '.length))))
  const report = Schema.decodeUnknownSync(Schema.Struct({
    accepted: Schema.Boolean, frames: Schema.Number, subscribed: Schema.Number, reconnects: Schema.Number,
    windows: Schema.Array(Schema.Struct({ atUnixMs: Schema.Number, samples: Schema.Number, rms: Schema.Number })),
  }))(JSON.parse(await readFile(env.MEDIA_LAB_MICROPHONE_REPORT, 'utf8')))
  const muted: number[] = [], audible: number[] = []
  for (let index = 0; index < phases.length; ++index) {
    const phase = phases[index]!
    const until = phases[index + 1]?.atUnixMs ?? Infinity
    const destination = phase.name === 'muted' ? muted : phase.name === 'audible' ? audible : undefined
    if (!destination) continue
    for (const window of report.windows) {
      if (window.atUnixMs >= phase.atUnixMs + 400 && window.atUnixMs + 100 < until) destination.push(window.rms)
    }
  }
  const maximumMutedRms = Math.max(0, ...muted)
  const maximumAudibleRms = Math.max(0, ...audible)
  const accepted = report.accepted && muted.length >= 4 && maximumMutedRms <= 2 && maximumAudibleRms >= 30
  const evidence = { accepted, seconds, maximumMutedRms, maximumAudibleRms, mutedWindows: muted.length, phases, publisher: publisher.output() }
  await writeFile(`${env.MEDIA_LAB_MICROPHONE_REPORT}.publication.json`, JSON.stringify(evidence, null, 2))
  console.log(JSON.stringify({ ...evidence, publisher: undefined, phases: undefined }))
  if (!accepted) throw new Error('Microphone observer audibility/silence evidence failed')
} finally {
  if (publisher) await writeFile(`${env.MEDIA_LAB_MICROPHONE_REPORT}.publisher.log`, publisher.output())
  for (const child of processes.reverse()) {
    if (child.exitCode !== null || child.signalCode !== null) continue
    const closed = new Promise<void>(resolve => child.once('close', () => resolve()))
    child.kill()
    await closed
  }
}
