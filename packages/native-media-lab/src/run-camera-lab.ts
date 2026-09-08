import { spawn, type ChildProcess } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { AccessToken } from 'livekit-server-sdk'
import { Schema } from 'effect'

const env = Schema.decodeUnknownSync(Schema.Struct({
  MEDIA_LAB_SERVER_EXE: Schema.String,
  MEDIA_LAB_CAMERA_EXE: Schema.String,
  MEDIA_LAB_CAMERA_REPORT: Schema.String,
  MEDIA_LAB_CAMERA_SECONDS: Schema.String,
}))(process.env)
const seconds = Number(env.MEDIA_LAB_CAMERA_SECONDS)
if (!Number.isInteger(seconds) || seconds < 24 || seconds > 1800) throw new Error('Invalid camera duration')
const directory = await mkdtemp(path.join(os.tmpdir(), 'syrnike-camera-'))
const processes: ChildProcess[] = []
const key = `camera_${randomBytes(12).toString('hex')}`, secret = randomBytes(32).toString('hex')
const url = 'ws://127.0.0.1:7890'
function start(executable: string, args: string[], overrides: NodeJS.ProcessEnv = {}, progress = false) {
  const child = spawn(executable, args, { env: { ...process.env, ...overrides }, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
  processes.push(child)
  let output = ''
  child.stdout?.on('data', chunk => {
    output = (output + String(chunk)).slice(-1_000_000)
    if (progress) process.stdout.write(String(chunk))
  })
  child.stderr?.on('data', chunk => { output = (output + String(chunk)).slice(-1_000_000) })
  const complete = new Promise<void>((resolve, reject) => {
    child.once('error', reject)
    child.once('close', code => code === 0 ? resolve() : reject(new Error(`${path.basename(executable)} exited ${code}\n${output.slice(-3000)}`)))
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
  await writeFile(config, `port: 7890\nbind_addresses: ["127.0.0.1"]\nrtc:\n  tcp_port: 7891\n  udp_port: 7892\n  node_ip: "127.0.0.1"\n  use_external_ip: false\nlogging:\n  level: warn\nkeys:\n  ${key}: ${secret}\n`)
  start(env.MEDIA_LAB_SERVER_EXE, ['--config', config])
  await until(async () => { try { return (await fetch('http://127.0.0.1:7890')).ok } catch { return false } }, 10_000, 'SFU startup timeout')
  const ready = path.join(directory, 'observer-ready')
  const observer = start(process.execPath, [fileURLToPath(new URL('./camera-observer.js', import.meta.url))], {
    LIVEKIT_URL: url, LIVEKIT_OBSERVER_TOKEN: await token('neutral-camera-observer'),
    MEDIA_LAB_READY_PATH: ready, MEDIA_LAB_REPORT_PATH: env.MEDIA_LAB_CAMERA_REPORT,
  })
  await until(async () => { try { return (await readFile(ready, 'utf8')).startsWith('ready') } catch { return false } }, 10_000, 'Observer startup timeout')
  publisher = start(env.MEDIA_LAB_CAMERA_EXE, ['publish', String(seconds)], {
    LIVEKIT_URL: url, LIVEKIT_PUBLISHER_TOKEN: await token('native-v2-publisher'),
  }, true)
  await Promise.race([
    Promise.all([publisher.complete, observer.complete]),
    new Promise<never>((_, reject) => {
      const timeout = setTimeout(() => reject(new Error('Camera lab deadline')), (seconds + 40) * 1000)
      timeout.unref()
    }),
  ])
  const Phase = Schema.Struct({ name: Schema.String, atUnixMs: Schema.Number })
  const phases = publisher.output().split(/\r?\n/).filter(line => line.startsWith('CAMERA_PHASE '))
    .map(line => Schema.decodeUnknownSync(Phase)(JSON.parse(line.slice('CAMERA_PHASE '.length))))
  const report = Schema.decodeUnknownSync(Schema.Struct({
    accepted: Schema.Boolean,
    windows: Schema.Array(Schema.Struct({ atUnixMs: Schema.Number, frames: Schema.Number, maximumAgeMs: Schema.Number })),
  }))(JSON.parse(await readFile(env.MEDIA_LAB_CAMERA_REPORT, 'utf8')))
  const stalled = phases.find(phase => phase.name === 'preview-stalled')
  const resumed = phases.find(phase => phase.name === 'preview-resumed')
  if (!stalled || !resumed) throw new Error('Preview stall evidence missing')
  const windows = report.windows.filter(window => window.atUnixMs > stalled.atUnixMs + 100 &&
    window.atUnixMs + 1000 < resumed.atUnixMs)
  const minimumStalledFps = Math.min(...windows.map(window => window.frames))
  const maximumStalledAgeMs = Math.max(...windows.map(window => window.maximumAgeMs))
  const accepted = report.accepted && windows.length >= 2 && minimumStalledFps >= 24 && maximumStalledAgeMs <= 500
  const evidence = { accepted, seconds, minimumStalledFps, maximumStalledAgeMs, phases }
  await writeFile(`${env.MEDIA_LAB_CAMERA_REPORT}.publication.json`, JSON.stringify(evidence, null, 2))
  console.log(JSON.stringify(evidence))
  if (!accepted) throw new Error('Camera publication degraded while preview stalled')
} finally {
  if (publisher) await writeFile(`${env.MEDIA_LAB_CAMERA_REPORT}.publisher.log`, publisher.output())
  for (const child of processes.reverse()) {
    if (child.exitCode !== null || child.signalCode !== null) continue
    const closed = new Promise<void>(resolve => child.once('close', () => resolve()))
    child.kill()
    await closed
  }
}
