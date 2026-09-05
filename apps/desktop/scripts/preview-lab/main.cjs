const { app, BrowserWindow, ipcMain, utilityProcess, sharedTexture } = require('electron')
const path = require('node:path'), fs = require('node:fs')
app.setPath('userData', process.env.PREVIEW_LAB_PROFILE)
const build = path.resolve(__dirname, '../../../../packages/windows-media-engine/build/Release')
const broker = require(path.join(build, 'video_bridge_lab.node'))
const { LocalPreviewBridge } = require('../../out/video-lab/local-preview-bridge.cjs')
const scenario = process.env.PREVIEW_LAB_SCENARIO
const duration = Number(process.env.PREVIEW_LAB_SECONDS || 20) * 1000
const report = { version: 1, scenario, frames: 0, samples: [], failures: [], transitions: [] }
let window, endpoint, bridge, ready = false, finishing = false, began = 0, revision = 1, injected = false, cycles = 0
let interval, deadline, latest
const record = phase => report.transitions.push({ phase, time: Date.now(), frames: report.frames })
function createWindow() {
  ready = false
  window = new BrowserWindow({ width: 900, height: 640, webPreferences: {
    preload: path.join(__dirname, 'preload.cjs'), sandbox: false, contextIsolation: true,
    nodeIntegration: false, backgroundThrottling: false,
  } })
  window.webContents.on('render-process-gone', () => { ready = false; bridge?.setReady(false) })
  window.loadFile(path.join(__dirname, 'index.html'))
}
const demand = enabled => endpoint.postMessage({ type: 'demand', enabled, revision: ++revision })
async function finish() {
  if (finishing) return
  finishing = true; record('publication-stop'); endpoint?.postMessage({ type: 'stop' })
  clearTimeout(deadline)
  if (scenario === 'publication-stop') await new Promise(resolve => setTimeout(resolve, 500))
  if (window && !window.isDestroyed()) {
    if (process.env.PREVIEW_LAB_SCREENSHOT) fs.writeFileSync(process.env.PREVIEW_LAB_SCREENSHOT,
      (await window.webContents.capturePage()).toPNG())
    window.destroy()
  }
  const until = Date.now() + 15000
  while (Date.now() < until) {
    endpoint?.postMessage({ type: 'metrics' }); bridge?.retryReleases()
    if (latest?.done && latest.backingBytes === 0 && bridge.outstanding === 0) break
    await new Promise(resolve => setTimeout(resolve, 50))
  }
  clearInterval(interval)
  report.final = latest; report.outstanding = bridge?.outstanding; report.cycles = cycles
  if (latest?.failure) report.failures.push(latest.failure)
  fs.writeFileSync(process.env.PREVIEW_LAB_REPORT, JSON.stringify(report, null, 2))
  endpoint?.kill()
  app.exit(report.failures.length === 0 && latest?.done && latest.backingBytes === 0 ? 0 : 1)
}
app.on('window-all-closed', () => {})
process.on('uncaughtException', error => { report.failures.push(error.message); void finish() })
app.whenReady().then(() => {
  createWindow()
  const current = event => window && !window.isDestroyed() && event.sender === window.webContents
  ipcMain.on('preview-ready', event => { if (current(event)) { ready = true; bridge?.setReady(true) } })
  ipcMain.on('preview-presented', event => { if (current(event)) report.frames++ })
  ipcMain.on('preview-renderer', (event, data) => { if (current(event)) report.renderer = data })
  endpoint = utilityProcess.fork(path.join(__dirname, 'utility.cjs'), [], {
    serviceName: 'Local preview contention lab', stdio: 'pipe',
    env: { ...process.env, PREVIEW_LAB_ADDON: path.join(build, 'preview_bridge_lab.node') },
  })
  bridge = new LocalPreviewBridge({ hostEpoch: 1,
    importTexture: (lease, released) => {
      const handle = broker.duplicate(endpoint.pid, lease.handle)
      try { return sharedTexture.importSharedTexture({ textureInfo: {
        pixelFormat: 'bgra', codedSize: { width: lease.width, height: lease.height },
        timestamp: lease.timestamp, handle: { ntHandle: handle },
      }, allReferencesReleased: () => { broker.closeHandle(handle); released() } }) }
      catch (error) { broker.closeHandle(handle); throw error }
    },
    sendTexture: (texture, metadata) => sharedTexture.sendSharedTexture({
      frame: window.webContents.mainFrame, importedSharedTexture: texture,
    }, metadata),
    returnLease: lease => endpoint.postMessage({ type: 'release', ...lease }),
    failure: code => { if (!report.failures.includes(code)) report.failures.push(code) },
  })
  endpoint.stderr.on('data', chunk => process.stderr.write(chunk))
  endpoint.on('exit', code => { if (!finishing) { report.failures.push(`utility exit ${code}`); void finish() } })
  endpoint.on('message', async message => {
    if (message.type === 'frame') {
      bridge.setReady(ready && !finishing && !window.isDestroyed())
      await bridge.offer(message.frame)
    } else if (message.type === 'released') bridge.acknowledgeRelease(message)
    else if (message.type === 'failure') { report.failures.push(message.message); void finish() }
    else if (message.type === 'metrics') {
      latest = message.metrics
      report.samples.push({ time: Date.now(), frames: report.frames, rendererHeld: report.renderer?.held ?? 0, ...latest })
      bridge.setGeneration(latest.generation)
      if (!window.isDestroyed()) window.webContents.send('preview-generation', latest.generation)
      if (!began && latest.publicationConsumed > 30) { began = Date.now(); record('running'); console.log('preview-lab-publishing') }
      if (latest.failure) { report.failures.push(latest.failure); void finish() }
      if (began && !finishing && (Date.now() - began >= duration || latest.done)) void finish()
    }
  })
  interval = setInterval(() => {
    endpoint.postMessage({ type: 'metrics' }); bridge.retryReleases()
    if (!began || finishing) return
    const elapsed = Date.now() - began
    if (!injected && elapsed >= 4000) {
      injected = true; record(scenario)
      if (['slow', 'never-release', 'late-join', 'publication-stop'].includes(scenario))
        window.webContents.send('preview-mode', scenario === 'slow' ? 'slow' : 'stall')
      if (scenario === 'reload' || scenario === 'close') {
        demand(false); ready = false; bridge.setReady(false)
        if (scenario === 'reload') window.reload()
        else { window.destroy(); createWindow() }
        demand(true)
      }
      if (scenario === 'pressure') endpoint.postMessage({ type: 'budget', bytes: 448 * 1024 * 1024 })
    }
    if (scenario === 'cycles' && elapsed >= 4000 && cycles < 100) {
      demand(false); demand(true); ++cycles
      if (cycles === 100) record('cycles-complete')
    }
  }, 100)
  deadline = setTimeout(() => { report.failures.push('harness deadline'); void finish() }, 85000)
})
