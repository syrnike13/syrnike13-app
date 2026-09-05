const { app, BrowserWindow, ipcMain, utilityProcess, sharedTexture } = require('electron')
const path = require('node:path')
const fs = require('node:fs')
if (process.env.VIDEO_LAB_PROFILE_DIR) {
  fs.mkdirSync(process.env.VIDEO_LAB_PROFILE_DIR, { recursive: true })
  app.setPath('userData', process.env.VIDEO_LAB_PROFILE_DIR)
}
const addonPath = path.resolve(__dirname, '../../../../packages/windows-media-engine/build/Release/video_bridge_lab.node')
const native = require(addonPath)
const { RemoteVideoBridge } = require('../../out/video-lab/remote-video-bridge.cjs')
const report = { version: 1, frames: 0, released: 0, failures: [], samples: [], renderer: null, transitions: [] }
let window
let utility
let ready = false
let closing = false
let pending = 0
let bridge
let metricsPending = false
const latencies = []
const duration = Number(process.env.VIDEO_LAB_SECONDS || 12)
if (!Number.isInteger(duration) || duration < 1 || duration > 720) throw Error('Duration must be 1..720 seconds')
const scenario = process.env.VIDEO_LAB_SCENARIO || 'normal'
let phase = 'normal'
function transition(next) { phase = next; report.transitions.push({ time: Date.now(), phase, frames: report.frames }) }
function createWindow() {
  ready = false
  window = new BrowserWindow({ width: 1000, height: 650, webPreferences: {
    preload: path.join(__dirname, 'preload.cjs'), sandbox: false, contextIsolation: true,
    nodeIntegration: false, backgroundThrottling: false,
  } })
  window.webContents.on('render-process-gone', () => { ready = false })
  window.loadFile(path.join(__dirname, 'index.html'))
}
app.on('window-all-closed', () => {})
async function finish() {
  if (closing) return
  closing = true
  utility?.postMessage({ type: 'stop' })
  if (process.env.VIDEO_LAB_REMOTE === '1') utility?.postMessage({ type: 'demand', enabled: false })
  if (window && !window.isDestroyed()) {
    if (process.env.VIDEO_LAB_SCREENSHOT) {
      try { fs.writeFileSync(process.env.VIDEO_LAB_SCREENSHOT, (await window.webContents.capturePage()).toPNG()) }
      catch (error) { report.failures.push(error.message) }
    }
    window.destroy()
  }
  const deadline = Date.now() + 3000
  while (Date.now() < deadline) {
    utility?.postMessage({ type: 'metrics' })
    await new Promise(resolve => setTimeout(resolve, 100))
    const last = report.samples.at(-1)
    pending = bridge?.outstanding ?? 0
    if (pending === 0 && (!process.env.VIDEO_LAB_REMOTE || last?.backingBytes === 0)) break
  }
  report.final = report.samples.at(-1)
  report.pending = pending
  fs.writeFileSync(process.env.VIDEO_LAB_REPORT || path.join(__dirname, 'report.json'), JSON.stringify(report, null, 2))
  if (utility) utility.kill()
  app.exit(report.frames > 0 && report.failures.length === 0 ? 0 : 1)
}
process.on('uncaughtException', error => { report.failures.push(error.message); finish() })
app.whenReady().then(() => {
  createWindow()
  const currentRenderer = event => window && !window.isDestroyed() && event.sender === window.webContents
  ipcMain.on('video-lab-ready', event => { if (currentRenderer(event)) ready = true })
  ipcMain.on('video-lab-presented', (event, value) => {
    if (!currentRenderer(event) || value.version !== 1) return
    report.frames++
    if (value.ingressUs > 0) {
      latencies.push((native.nowMicros() - value.ingressUs) / 1000)
      if (latencies.length > 1024) latencies.shift()
    }
  })
  ipcMain.on('video-lab-renderer-metrics', (event, value) => {
    if (currentRenderer(event)) report.renderer = value
  })
  utility = utilityProcess.fork(path.join(__dirname, 'utility.cjs'), [], {
    serviceName: 'Video bridge lab', env: { ...process.env, VIDEO_BRIDGE_ADDON: addonPath },
    stdio: 'pipe',
  })
  const endpoint = utility
  bridge = new RemoteVideoBridge({
    hostEpoch: 1,
    importTexture: (lease, released) => {
      const handle = native.duplicate(endpoint.pid, lease.handle)
      try {
        return sharedTexture.importSharedTexture({ textureInfo: {
          pixelFormat: 'bgra', codedSize: { width: lease.width, height: lease.height },
          timestamp: lease.timestamp, handle: { ntHandle: handle },
        }, allReferencesReleased: () => { native.closeHandle(handle); released() } })
      } catch (error) { native.closeHandle(handle); throw error }
    },
    sendTexture: (texture, metadata) => sharedTexture.sendSharedTexture({
      frame: window.webContents.mainFrame, importedSharedTexture: texture,
    }, metadata),
    returnLease: lease => endpoint.postMessage({ type: 'release', generation: lease.generation, sequence: lease.sequence, slot: lease.slot }),
    failure: code => { if (!report.failures.includes(code)) report.failures.push(code) },
  })
  utility.on('message', async message => {
    if (closing && message.type === 'frame') {
      utility.postMessage({ type: 'release', generation: message.lease.generation, sequence: message.lease.sequence, slot: message.lease.slot })
      return
    }
    if (message.type === 'failure') { report.failures.push(message.message); finish(); return }
    if (message.type === 'generation') {
      bridge.setGeneration(message.generation)
      if (!window.isDestroyed()) window.webContents.send('video-lab-generation', message.generation)
      return
    }
    if (message.type === 'metrics') {
      metricsPending = false
      if (message.metrics.room === 'connected' && !report.connected) {
        report.connected = true
        console.log('video-lab-connected')
      }
      const sorted = [...latencies].sort((a, b) => a - b)
      report.samples.push({ time: Date.now(), phase, presented: report.frames,
        latencyP50Ms: sorted[Math.floor(sorted.length * 0.5)] ?? 0,
        latencyP95Ms: sorted[Math.floor(sorted.length * 0.95)] ?? 0, ...message.metrics })
      if (message.metrics.failed && !report.failures.includes('Remote video worker failed')) report.failures.push('Remote video worker failed')
      if (message.metrics.backingBytes > 256 * 1024 * 1024) report.failures.push('Backing budget exceeded')
      return
    }
    if (message.type === 'released') {
      if (bridge.acknowledgeRelease(message) && message.accepted) report.released++
      return
    }
    if (message.type !== 'frame') return
    const lease = message.lease
    bridge.setReady(ready && !window.isDestroyed())
    await bridge.offer(lease)
  })
  utility.stderr.on('data', chunk => process.stderr.write(chunk))
  setInterval(() => {
    bridge.retryReleases()
    if (!closing && !metricsPending) { metricsPending = true; utility.postMessage({ type: 'metrics' }) }
  }, 1000)
  utility.on('exit', code => { if (!closing) { report.failures.push(`Utility exit ${code}`); finish() } })
  if (scenario === 'stall' || scenario === 'slow') {
    setTimeout(() => { transition(scenario); window.webContents.send('video-lab-mode', scenario) }, 5000)
    setTimeout(() => { transition('resume'); window.webContents.send('video-lab-mode', 'normal') }, scenario === 'stall' ? 35000 : 15000)
  }
  if (scenario === 'reload' || scenario === 'crash' || scenario === 'close') {
    setTimeout(() => {
      transition(scenario); ready = false
      if (scenario === 'reload') window.reload()
      else if (scenario === 'crash') {
        window.webContents.forcefullyCrashRenderer()
        setTimeout(() => window.reload(), 1000)
      } else { window.destroy(); setTimeout(createWindow, 1000) }
    }, 5000)
  }
  if (scenario === 'cycles') {
    let cycles = 0
    const timer = setInterval(() => {
      if (++cycles > 30) { clearInterval(timer); transition('cycles-complete'); return }
      transition(`off-${cycles}`); ready = false
      utility.postMessage({ type: 'demand', enabled: false })
      setTimeout(() => {
        transition(`on-${cycles}`)
        utility.postMessage({ type: 'demand', enabled: true }); ready = true
      }, 750)
    }, 1500)
  }
  setTimeout(finish, duration * 1000)
})
