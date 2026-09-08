import { spawn, type ChildProcess } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { mkdtemp, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { AccessToken } from 'livekit-server-sdk'
import { Schema } from 'effect'

const env = Schema.decodeUnknownSync(Schema.Struct({
  MEDIA_LAB_SERVER_EXE: Schema.String,
  MEDIA_LAB_AUDIO_BIN: Schema.String,
  MEDIA_LAB_REMOTE_AUDIO_REPORT: Schema.String,
  MEDIA_LAB_REMOTE_AUDIO_SECONDS: Schema.String,
  MEDIA_LAB_REMOTE_AUDIO_MODE: Schema.optional(Schema.Literals(['mix', 'routing', 'echo-publication', 'delay'])),
}))(process.env)
const seconds = Number(env.MEDIA_LAB_REMOTE_AUDIO_SECONDS)
const routing = env.MEDIA_LAB_REMOTE_AUDIO_MODE === 'routing'
const echoPublication = env.MEDIA_LAB_REMOTE_AUDIO_MODE === 'echo-publication'
const readerDelay = env.MEDIA_LAB_REMOTE_AUDIO_MODE === 'delay'
const port = routing ? 7906 : echoPublication ? 7916 : 7896
const scope = routing ? 'livekit-audio-routing' : echoPublication ?
  'rendered-reference-published-microphone-output-loss' : 'livekit-mixer-rendered-reference'
if (!Number.isInteger(seconds) || seconds < 23 || seconds > 1800) throw new Error('Invalid remote audio duration')
const directory = await mkdtemp(path.join(os.tmpdir(), 'syrnike-remote-audio-'))
const key = `audio_${randomBytes(12).toString('hex')}`
const secret = randomBytes(32).toString('hex')
const processes: ChildProcess[] = []
const executable = path.join(env.MEDIA_LAB_AUDIO_BIN, 'remote_audio_lab.exe')
const url = `ws://127.0.0.1:${port}`
function start(file: string, args: string[], overrides: NodeJS.ProcessEnv = {}) {
  const child = spawn(file, args, {
    env: { ...process.env, ...overrides }, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
  })
  processes.push(child)
  let output = ''
  const append = (chunk: Buffer) => {
    output = (output + String(chunk)).slice(-1_000_000)
    for (const line of String(chunk).split(/\r?\n/))
      if (line.startsWith('REMOTE_AUDIO_RESOURCE ')) console.log(line)
  }
  child.stdout?.on('data', append)
  child.stderr?.on('data', append)
  const complete = new Promise<void>((resolve, reject) => {
    child.once('error', reject)
    child.once('close', code => code === 0 ? resolve() : reject(new Error(`${path.basename(file)} exited ${code}\n${output.slice(-4000)}`)))
  })
  void complete.catch(() => undefined)
  return { complete, output: () => output }
}
async function until(predicate: () => Promise<boolean>, description: string) {
  const deadline = performance.now() + 15_000
  while (performance.now() < deadline) {
    if (await predicate()) return
    await new Promise(resolve => setTimeout(resolve, 50))
  }
  throw new Error(description)
}
async function token(identity: string) {
  const value = new AccessToken(key, secret, { identity, ttl: '1h' })
  value.addGrant({ roomJoin: true, room: 'native-v2-remote-audio-lab', canPublish: true, canSubscribe: true })
  return value.toJwt()
}
let receiver: ReturnType<typeof start> | undefined
let server: ReturnType<typeof start> | undefined
try {
  await writeFile(env.MEDIA_LAB_REMOTE_AUDIO_REPORT, JSON.stringify({ status: 'running', seconds }) + '\n')
  const config = path.join(directory, 'livekit.yaml')
  await writeFile(config, `port: ${port}\nbind_addresses: ["127.0.0.1"]\nrtc:\n  tcp_port: ${port + 1}\n  udp_port: ${port + 2}\n  node_ip: "127.0.0.1"\n  use_external_ip: false\nlogging:\n  level: warn\nkeys:\n  ${key}: ${secret}\n`)
  server = start(env.MEDIA_LAB_SERVER_EXE, ['--config', config])
  await until(async () => { try { return (await fetch(`http://127.0.0.1:${port}`)).ok } catch { return false } }, 'SFU startup timeout')
  if (routing) {
    receiver = start(executable, ['routing'], {
      LIVEKIT_URL: url,
      LIVEKIT_PUBLISHER_TOKEN: await token('remote-a'),
      LIVEKIT_OBSERVER_TOKEN: await token('remote-listener'),
    })
  } else {
    const first = start(executable, ['publish', String(seconds + 20), '700'], {
      LIVEKIT_URL: url, LIVEKIT_PUBLISHER_TOKEN: await token('remote-a'),
    })
    const second = start(executable, ['publish', String(seconds + 20), '1300'], {
      LIVEKIT_URL: url, LIVEKIT_PUBLISHER_TOKEN: await token('remote-b'),
    })
    await until(async () => first.output().includes('REMOTE_AUDIO_PUBLISHER_READY') &&
      second.output().includes('REMOTE_AUDIO_PUBLISHER_READY'), 'Publisher startup timeout')
    receiver = start(executable, echoPublication ? ['echo-publication'] : [readerDelay ? 'receive-delay' : 'receive', String(seconds)], {
      LIVEKIT_URL: url, LIVEKIT_OBSERVER_TOKEN: await token('remote-listener'),
    })
  }
  await Promise.race([
    receiver.complete,
    new Promise<never>((_, reject) => {
      const timer = setTimeout(() => reject(new Error('Remote audio lab deadline')), routing ? 90_000 : (seconds + 30) * 1000)
      timer.unref()
    }),
  ])
  const line = receiver.output().split(/\r?\n/).find(value => value.startsWith(`{"scope":"${scope}"`))
  if (!line) throw new Error('Remote audio report missing')
  const report = Schema.decodeUnknownSync(Schema.Struct({ status: Schema.Literal('pass') }))(JSON.parse(line))
  await writeFile(env.MEDIA_LAB_REMOTE_AUDIO_REPORT, line + '\n')
  console.log(JSON.stringify(report))
} catch (error) {
  await writeFile(env.MEDIA_LAB_REMOTE_AUDIO_REPORT, JSON.stringify({
    scope, status: 'fail', seconds, reason: 'Lab failed; inspect the adjacent log files',
  }) + '\n')
  throw error
} finally {
  if (server) await writeFile(`${env.MEDIA_LAB_REMOTE_AUDIO_REPORT}.server.log`, server.output())
  if (receiver) {
    await writeFile(`${env.MEDIA_LAB_REMOTE_AUDIO_REPORT}.log`, receiver.output())
    const report = receiver.output().split(/\r?\n/).find(value => value.startsWith(`{"scope":"${scope}"`))
    if (report) await writeFile(env.MEDIA_LAB_REMOTE_AUDIO_REPORT, report + '\n')
  }
  for (const child of processes.reverse()) {
    if (child.exitCode !== null || child.signalCode !== null) continue
    const closed = new Promise<void>(resolve => child.once('close', () => resolve()))
    child.kill()
    await closed
  }
}
