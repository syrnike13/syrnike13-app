import { AccessToken } from 'livekit-server-sdk'
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { randomBytes } from 'node:crypto'
import { access, mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { verifyViewer } from './verify-viewer.mjs'

const root = path.resolve(import.meta.dirname, '../../..')
const requireDesktop = createRequire(path.join(root, 'apps/desktop/package.json'))
const serverPath = process.env.MEDIA_LAB_SERVER_EXE
if (!serverPath || !path.isAbsolute(serverPath)) throw Error('MEDIA_LAB_SERVER_EXE must be an absolute local LiveKit server path')
await access(serverPath)
const seconds = Number(process.env.VIDEO_LAB_SECONDS || 20)
if (!Number.isInteger(seconds) || seconds < 1 || seconds > 720) throw Error('VIDEO_LAB_SECONDS must be 1..720')
const scenario = process.env.VIDEO_LAB_SCENARIO || 'normal'
if (!['normal', 'stall', 'slow', 'reload', 'crash', 'close', 'cycles', 'replace'].includes(scenario)) throw Error('Unknown viewer scenario')
const artifacts = path.join(root, 'packages/native-media-lab/artifacts')
await mkdir(artifacts, { recursive: true })
const reportPath = process.env.VIDEO_LAB_REPORT || path.join(artifacts, `remote-video-${scenario}.json`)
const temporary = await mkdtemp(path.join(tmpdir(), 'syrnike-viewer-'))
const key = randomBytes(12).toString('hex'), secret = randomBytes(32).toString('hex')
const config = path.join(temporary, 'livekit.yaml')
await writeFile(config, `port: 17980\nbind_addresses: [127.0.0.1]\nrtc:\n  tcp_port: 17981\n  udp_port: 17982\n  use_external_ip: false\n  node_ip: 127.0.0.1\nkeys:\n  ${key}: ${secret}\nlogging:\n  level: warn\n`)
const children = []
function launch(executable, args, options = {}) {
  const child = spawn(executable, args, { windowsHide: true, ...options })
  const done = new Promise(resolve => {
    child.once('exit', code => resolve(code ?? 1))
    child.once('error', () => resolve(1))
  })
  children.push({ child, done })
  return { child, done }
}
const server = launch(serverPath, ['--config', config], { stdio: ['ignore', 'ignore', 'pipe'] })
let serverDiagnostics = ''
server.child.stderr.on('data', chunk => { serverDiagnostics = (serverDiagnostics + chunk).slice(-8192) })
let publisherDiagnostics = ''
let publisherExitCode = null
let deadline
try {
  let ready = false
  for (let i = 0; i < 100; ++i) {
    if (server.child.exitCode !== null) throw Error('Disposable LiveKit server exited')
    try { await fetch('http://127.0.0.1:17980'); ready = true; break } catch {}
    await new Promise(resolve => setTimeout(resolve, 50))
  }
  if (!ready) throw Error('Disposable LiveKit server failed to become ready')
  const token = async identity => {
    const accessToken = new AccessToken(key, secret, { identity, ttl: '20m' })
    accessToken.addGrant({ room: 'viewer-lab', roomJoin: true, canPublish: true, canSubscribe: true })
    return accessToken.toJwt()
  }
  const env = { ...process.env, LIVEKIT_URL: 'ws://127.0.0.1:17980',
    LIVEKIT_OBSERVER_TOKEN: await token('viewer'), LIVEKIT_PUBLISHER_TOKEN: await token('publisher'),
    VIDEO_LAB_ROOM: 'viewer-lab', VIDEO_LAB_REMOTE: '1', VIDEO_LAB_REPORT: reportPath,
    VIDEO_LAB_PROFILE_DIR: path.join(temporary, 'electron-profile'),
    VIDEO_LAB_SECONDS: String(seconds), VIDEO_LAB_SCENARIO: scenario }
  const viewer = launch(requireDesktop('electron'), [path.join(root, 'apps/desktop/scripts/video-bridge-lab/main.cjs')], { env })
  let started = false
  let stdout = ''
  viewer.child.stdout.on('data', chunk => {
    stdout = (stdout + chunk).slice(-4096)
    if (!started && stdout.includes('video-lab-connected')) {
      started = true
      const publisher = launch(path.join(root, 'packages/windows-media-engine/build/Release/remote_video_publisher.exe'), [],
        { env, stdio: ['ignore', 'ignore', 'pipe'] })
      publisher.child.stderr.on('data', chunk => { publisherDiagnostics = (publisherDiagnostics + chunk).slice(-8192) })
      publisher.done.then(code => { publisherExitCode = code })
    }
  })
  viewer.child.stderr.on('data', chunk => process.stderr.write(chunk))
  deadline = setTimeout(() => viewer.child.kill(), (seconds + 30) * 1000)
  const code = await viewer.done
  clearTimeout(deadline)
  const report = JSON.parse(await readFile(reportPath, 'utf8'))
  const acceptanceErrors = verifyViewer(report, scenario, seconds)
  if (publisherExitCode !== null) acceptanceErrors.push(`Publisher exited early: ${publisherExitCode}`)
  if (server.child.exitCode !== null) acceptanceErrors.push(`Server exited early: ${server.child.exitCode}`)
  const accepted = code === 0 && acceptanceErrors.length === 0
  if (!accepted && serverDiagnostics) process.stderr.write(serverDiagnostics)
  if (!accepted && publisherDiagnostics) process.stderr.write(publisherDiagnostics)
  console.log(JSON.stringify({ accepted, scenario, frames: report.frames, reportPath,
    finalBackingBytes: report.final?.backingBytes, failures: report.failures, acceptanceErrors }))
  process.exitCode = accepted ? 0 : 1
} finally {
  clearTimeout(deadline)
  for (const { child } of children.toReversed()) child.kill()
  await Promise.all(children.map(({ done }) => done))
  if (!path.resolve(temporary).startsWith(path.join(tmpdir(), 'syrnike-viewer-'))) throw Error('Unsafe temporary path')
  await rm(temporary, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
}
