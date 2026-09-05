import { AccessToken } from 'livekit-server-sdk'
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { randomBytes } from 'node:crypto'
import { access, mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { verifyPreview } from './verify-preview.mjs'

const root = path.resolve(import.meta.dirname, '../../..')
const desktopRequire = createRequire(path.join(root, 'apps/desktop/package.json'))
const serverPath = process.env.MEDIA_LAB_SERVER_EXE
if (!serverPath || !path.isAbsolute(serverPath)) throw Error('MEDIA_LAB_SERVER_EXE must be an absolute server path')
await access(serverPath)
const scenario = process.env.PREVIEW_LAB_SCENARIO || 'normal'
if (!['normal', 'monitor', 'slow', 'never-release', 'cycles', 'reload', 'close', 'resize', 'source-close',
  'pressure', 'late-join', 'publication-stop'].includes(scenario)) throw Error('Unknown preview scenario')
const seconds = Number(process.env.PREVIEW_LAB_SECONDS || 20)
if (!Number.isInteger(seconds) || seconds < 18 || seconds > 60) throw Error('Preview duration must be 18..60 seconds')
const artifacts = path.join(root, 'packages/native-media-lab/artifacts')
await mkdir(artifacts, { recursive: true })
const reportPath = process.env.PREVIEW_LAB_REPORT || path.join(artifacts, `preview-${scenario}.json`)
const observerPath = `${reportPath}.observer.json`
const temporary = await mkdtemp(path.join(tmpdir(), 'syrnike-preview-'))
const config = path.join(temporary, 'livekit.yaml')
const key = randomBytes(12).toString('hex'), secret = randomBytes(32).toString('hex')
await writeFile(config, `port: 17990\nbind_addresses: [127.0.0.1]\nrtc:\n  tcp_port: 17991\n  udp_port: 17992\n  use_external_ip: false\n  node_ip: 127.0.0.1\nkeys:\n  ${key}: ${secret}\nlogging:\n  level: warn\n`)
const children = []
function launch(executable, args, env) {
  const child = spawn(executable, args, { env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
  let diagnostics = ''
  child.stderr.on('data', chunk => { diagnostics = (diagnostics + chunk).slice(-8192) })
  const done = new Promise(resolve => {
    child.once('exit', code => resolve(code ?? 1)); child.once('error', () => resolve(1))
  })
  const item = { child, done, diagnostics: () => diagnostics }; children.push(item); return item
}
const server = launch(serverPath, ['--config', config], process.env)
let deadline, joinTimer
try {
  let ready = false
  for (let attempt = 0; attempt < 100; ++attempt) {
    if (server.child.exitCode !== null) throw Error('Server exited')
    try { await fetch('http://127.0.0.1:17990'); ready = true; break } catch {}
    await new Promise(resolve => setTimeout(resolve, 50))
  }
  if (!ready) throw Error('Server readiness deadline')
  const token = async identity => {
    const jwt = new AccessToken(key, secret, { identity, ttl: '10m' })
    jwt.addGrant({ room: 'preview-lab', roomJoin: true, canPublish: true, canSubscribe: true })
    return jwt.toJwt()
  }
  const env = { ...process.env, LIVEKIT_URL: 'ws://127.0.0.1:17990',
    LIVEKIT_PUBLISHER_TOKEN: await token('publisher'), LIVEKIT_OBSERVER_TOKEN: await token('observer'),
    PREVIEW_LAB_SCENARIO: scenario, PREVIEW_LAB_SECONDS: String(seconds), PREVIEW_LAB_REPORT: reportPath,
    PREVIEW_OBSERVER_REPORT: observerPath, PREVIEW_LAB_PROFILE: path.join(temporary, 'electron') }
  const startObserver = () => launch(process.execPath, [path.join(import.meta.dirname, 'preview-observer.mjs')], env)
  let observer
  if (scenario !== 'late-join') {
    observer = startObserver()
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(Error('Observer readiness deadline')), 15000)
      observer.child.stdout.on('data', chunk => {
        if (chunk.toString().includes('preview-observer-ready')) { clearTimeout(timeout); resolve() }
      })
      observer.done.then(() => { clearTimeout(timeout); reject(Error('Observer exited before ready')) })
    })
  }
  const preview = launch(desktopRequire('electron'), [path.join(root, 'apps/desktop/scripts/preview-lab/main.cjs')], env)
  let observerScheduled = false
  preview.child.stdout.on('data', chunk => {
    if (scenario === 'late-join' && !observerScheduled && chunk.toString().includes('preview-lab-publishing')) {
      observerScheduled = true
      joinTimer = setTimeout(() => { observer = startObserver() }, 7000)
    }
  })
  deadline = setTimeout(() => { for (const item of children) item.child.kill() }, 110000)
  const code = await preview.done
  if (code !== 0) throw Error(`Preview process failed (${code}): ${preview.diagnostics()}\n${await readFile(reportPath, 'utf8').catch(() => 'No report')}`)
  if (!observer) throw Error('Late observer did not start')
  const observerCode = await observer.done
  const previewReport = JSON.parse(await readFile(reportPath, 'utf8'))
  const observerReport = JSON.parse(await readFile(observerPath, 'utf8'))
  const errors = verifyPreview(previewReport, observerReport, scenario)
  if (code !== 0 || observerCode !== 0 || server.child.exitCode !== null) errors.push('Child process failed')
  const result = { accepted: errors.length === 0, scenario, errors, preview: previewReport, observer: observerReport }
  await writeFile(`${reportPath}.acceptance.json`, JSON.stringify(result, null, 2))
  console.log(JSON.stringify({ accepted: result.accepted, scenario, errors, previewFrames: previewReport.frames,
    observerFrames: observerReport.frames, observerFps: observerReport.averageFps, observerP95AgeMs: observerReport.p95AgeMs }))
  if (errors.length) for (const item of children) process.stderr.write(item.diagnostics())
  process.exitCode = result.accepted ? 0 : 1
} finally {
  clearTimeout(deadline); clearTimeout(joinTimer)
  for (const item of children.toReversed()) item.child.kill()
  await Promise.all(children.map(item => item.done))
  if (!path.resolve(temporary).startsWith(path.join(tmpdir(), 'syrnike-preview-'))) throw Error('Unsafe temporary path')
  await rm(temporary, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
}
