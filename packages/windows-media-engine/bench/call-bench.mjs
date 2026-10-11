// Local call benchmark for the Windows media engine.
//
// Starts a dev LiveKit server, loads windows_media.node into this Node process
// (the same addon the Electron utility hosts), drives it through a product-like
// call with synthetic bench_bot participants and prints one JSON report:
// join, voice, screen viewing, screen sharing, channel move and leave.
//
//   node packages/windows-media-engine/bench/call-bench.mjs --server <livekit-server.exe>
//
// The output device volume is 0, so bots are mixed and rendered but silent.
import { spawn, execFileSync } from 'node:child_process'
import crypto from 'node:crypto'
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const options = Object.fromEntries(process.argv.slice(2).reduce((pairs, value, index, all) =>
  index % 2 === 0 ? [...pairs, [value.replace(/^--/, ''), all[index + 1]]] : pairs, []))
const serverPath = options.server
if (!serverPath) throw new Error('--server <livekit-server.exe> is required')
const addonPath = options.addon ?? path.join(packageRoot, 'dist', 'win32-x64', 'windows_media.node')
const botPath = options.bot ?? path.join(packageRoot, 'build', 'Release', 'bench_bot.exe')
const fixturePath = options.fixture ?? path.join(packageRoot, 'build', 'Release', 'source_window_fixture.exe')
const phaseSeconds = Number(options.seconds ?? 20)
// --port P runs the dev server on P (RTC on P+1/P+2) beside another LiveKit.
const port = Number(options.port ?? 7880)
const url = `ws://127.0.0.1:${port}`
// --signal-delay-ms N routes the engine's signaling through a TCP proxy that
// delays every chunk by N ms each way (RTT 2N). Media stays on direct UDP.
const signalDelayMs = Number(options['signal-delay-ms'] ?? 0)
// --dead-network-before-leave 1 makes that proxy swallow all signaling just
// before leaving, as if the network died mid-call.
const deadNetworkBeforeLeave = options['dead-network-before-leave'] === '1'
const proxied = signalDelayMs > 0 || deadNetworkBeforeLeave
const proxyPort = port === 7880 ? 7881 : port + 10
const engineUrl = proxied ? `ws://127.0.0.1:${proxyPort}` : url
let signalingDead = false
const self = 'bench-engine'

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
const now = () => performance.now()

function token(identity, room) {
  const encode = value => Buffer.from(JSON.stringify(value)).toString('base64url')
  const issued = Math.floor(Date.now() / 1000)
  const body = `${encode({ alg: 'HS256', typ: 'JWT' })}.${encode({
    iss: 'devkey', sub: identity, name: identity, nbf: issued - 10, exp: issued + 3600,
    video: { room, roomJoin: true, canPublish: true, canSubscribe: true },
  })}`
  return `${body}.${crypto.createHmac('sha256', 'secret').update(body).digest('base64url')}`
}

async function waitFor(condition, timeoutMs, label) {
  const started = now()
  while (!condition()) {
    if (now() - started > timeoutMs) throw new Error(`Timed out waiting for ${label}`)
    await sleep(5)
  }
  return now() - started
}

function threadCount() {
  return Number(execFileSync('powershell', ['-NoProfile', '-Command',
    `(Get-Process -Id ${process.pid}).Threads.Count`], { encoding: 'utf8' }).trim())
}

function bot(identity, room, args) {
  const child = spawn(botPath, ['--url', url, '--token', token(identity, room), ...args],
    { stdio: ['ignore', 'pipe', 'inherit'] })
  let output = ''
  child.stdout.on('data', chunk => { output += chunk })
  const done = new Promise(resolve => child.on('exit', () => {
    try { resolve(JSON.parse(output.trim().split('\n').at(-1))) } catch { resolve(null) }
  }))
  return { child, done }
}

const server = spawn(serverPath, ['--dev', '--bind', '127.0.0.1', ...(port === 7880 ? [] : ['--config-body',
  `{port: ${port}, rtc: {tcp_port: ${port + 1}, udp_port: ${port + 2}}, keys: {devkey: secret}}`])],
  { stdio: 'ignore' })
if (proxied) {
  const net = await import('node:net')
  const delayed = (from, to) => from.on('data', chunk => setTimeout(() => {
    if (!signalingDead) to.write(chunk)
  }, signalDelayMs))
  net.createServer(client => {
    const upstream = net.connect(port, '127.0.0.1')
    delayed(client, upstream)
    delayed(upstream, client)
    const close = () => { client.destroy(); upstream.destroy() }
    client.on('error', close).on('close', close)
    upstream.on('error', close).on('close', close)
  }).listen(proxyPort, '127.0.0.1').unref()
}
const bots = []
const report = { addon: addonPath, phaseSeconds, signalDelayMs, deadNetworkBeforeLeave }
try {
  for (let attempt = 0; ; attempt += 1) {
    try { if ((await fetch(`http://127.0.0.1:${port}`)).ok) break } catch {}
    if (attempt > 200) throw new Error('LiveKit server did not start')
    await sleep(50)
  }

  const addon = createRequire(import.meta.url)(addonPath)
  const tracks = {}
  let room = 'off'
  const metrics = {}
  const frames = new Map()
  let pendingReleases = []
  let framesBusy = false
  addon.registerPublicEventCallback(event => {
    if (event.type === 'roomStateChanged') room = event.state
    if (event.type === 'trackStateChanged') tracks[event.track] = { state: event.state, failure: event.failure?.code, revision: event.revision }
    // In the product a fatal engine failure kills and restarts the media process.
    if (event.type === 'fatalEngineFailure')
      (report.fatal ??= []).push({ code: event.failure.code, stage: event.failure.stage, atMs: Math.round(now()) })
    if (event.type === 'roomStateChanged' && event.state === 'failed') (report.roomFailures ??= []).push(event.failure?.code)
  })
  addon.registerDiagnosticEventCallback(event => {
    if (event.operation === 'sample')
      metrics[event.code] = Object.fromEntries(event.metrics.map(metric => [metric.name, metric.value]))
  })
  const pullFrames = () => {
    if (framesBusy) return
    framesBusy = true
    setImmediate(() => {
      framesBusy = false
      const exported = addon.queryFrames(pendingReleases).frames
      pendingReleases = exported.map(({ generation, sequence, slot }) => ({ generation, sequence, slot }))
      for (const frame of exported) frames.set(frame.publicationId, (frames.get(frame.publicationId) ?? 0) + 1)
      if (pendingReleases.length) pullFrames()
    })
  }
  addon.registerFramesReadyCallback(pullFrames)
  addon.handshake()

  let revision = 0
  const microphone = {
    state: 'warm', deviceId: null, muted: false, pushToTalk: false, pushToTalkHeld: false,
    bypassSystemProcessing: false, automaticGainControl: true, noiseSuppression: true,
    echoCancellation: true, inputVolume: 1, gateEnabled: true, gateThresholdDb: -50,
    gateAutoThreshold: true, meterDemand: false, retryRevision: 0,
  }
  const output = { state: 'on', deviceId: null, deafened: false, volume: 0, users: [], streams: [], retryRevision: 0 }
  let desired = {
    revision, room: null, microphone, camera: { state: 'off' }, screen: { state: 'off' },
    output: { state: 'off' }, remoteVideoDemand: [], rendererId: null,
  }
  const apply = patch => {
    desired = { ...desired, ...patch, revision: ++revision }
    addon.applyDesiredState(desired, 1000)
  }
  const lease = (name) => {
    const leaseId = `lease-${name}-${revision + 1}`
    addon.installCredentialLease({ leaseId, serverUrl: engineUrl, accessToken: token(self, name) }, 1000)
    return { roomId: name, participantIdentity: self, credentialLeaseId: leaseId }
  }
  const measure = async (seconds) => {
    // Diagnostic samples arrive once per second; start from a fresh one.
    await sleep(1100)
    const cpu = process.cpuUsage()
    const started = now()
    const before = structuredClone(metrics)
    await sleep(seconds * 1000)
    const used = process.cpuUsage(cpu)
    const elapsed = now() - started
    const delta = (code, names) => Object.fromEntries(names.map(name =>
      [name, (metrics[code]?.[name] ?? 0) - (before[code]?.[name] ?? 0)]))
    return {
      cpuPercentOfOneCore: Number(((used.user + used.system) / 1000 / elapsed * 100).toFixed(1)),
      threads: threadCount(), elapsedMs: Math.round(elapsed), delta, metrics: structuredClone(metrics),
    }
  }

  // Every counter of both the previous and the simplified audio paths; a name
  // the measured build does not export reads as zero.
  const voiceMetrics = sample => ({
    remoteAudio: {
      ...sample.delta('remote_audio_ingress_metrics', ['decoded', 'sdk_dropped', 'sdk_stale', 'sdk_discontinuities',
        'app_overrun', 'app_stale', 'jitter_underruns', 'jitter_overruns', 'jitter_trimmed']),
      ...sample.delta('remote_audio_output_metrics', ['underruns', 'stale_fragments', 'mix_discontinuities',
        'device_starved', 'late_wakes']),
    },
    playoutLatencyMs: sample.metrics.remote_audio_output_metrics?.latency_ms ??
      Math.round((sample.metrics.remote_audio_output_metrics?.maximum_scheduled_age_us ?? 0) / 1000),
    microphoneRaw: sample.metrics.microphone_metrics,
    microphone: {
      ...sample.delta('microphone_metrics', ['capture_frames', 'dsp_frames', 'dsp_stale', 'submitted', 'rejected_stale']),
      // 10 ms frames in the measured window (counters are sampled once per second).
      expectedFrames: Math.round(sample.elapsedMs / 10),
    },
  })

  // Idle app: microphone warm, no Room.
  apply({})
  report.microphoneWarmMs = Math.round(await waitFor(() => tracks.microphone?.state === 'running' ||
    tracks.microphone?.state === 'failed', 10_000, 'warm microphone'))
  report.microphoneWarmState = tracks.microphone?.state
  report.idle = await measure(5)

  // Others are already talking in the channel.
  for (const identity of ['talker-1', 'talker-2', 'talker-3'])
    bots.push(bot(identity, 'bench-a', ['--seconds', String(phaseSeconds * 5), '--speak', '1']))
  await sleep(1500)

  // Join.
  const joinStarted = now()
  apply({ room: lease('bench-a'), microphone: { ...microphone, state: 'on' }, output })
  await waitFor(() => room === 'connected', 15_000, 'join')
  report.join = { connectedMs: Math.round(now() - joinStarted) }
  await waitFor(() => tracks.microphone?.state === 'running' && tracks.output?.state === 'running', 15_000, 'join media')
  report.join.mediaReadyMs = Math.round(now() - joinStarted)
  await waitFor(() => addon.queryInventory().inventory.activeSpeakers.length >= 3, 15_000, 'hearing every talker')
  report.join.hearingAllMs = Math.round(now() - joinStarted)
  if (options['join-only'] === '1') throw new Error('join-only')

  // Voice.
  const voice = await measure(phaseSeconds)
  report.voice = {
    cpuPercentOfOneCore: voice.cpuPercentOfOneCore, threads: voice.threads,
    ...voiceMetrics(voice),
  }

  // Switch output and input devices mid-call and back to the defaults.
  const devices = addon.queryInventory().inventory.audio.devices
  const otherOutput = devices.find(device => device.direction === 'output' && !device.isDefault)
  const otherInput = devices.find(device => device.direction === 'input' && !device.isDefault)
  if (otherOutput && otherInput) {
    const counter = (code, name) => metrics[code]?.[name] ?? 0
    const switchTo = async (patch, path, label) => {
      const started = now()
      apply(patch)
      const target = revision
      await waitFor(() => tracks[path]?.revision >= target &&
        (tracks[path].state === 'running' || tracks[path].state === 'failed'), 10_000, label)
      return { ms: Math.round(now() - started), state: tracks[path]?.state, failure: tracks[path]?.failure }
    }
    const renderedBefore = counter('remote_audio_output_metrics', 'rendered_frames')
    const sentBefore = counter('microphone_metrics', 'submitted')
    report.deviceSwitch = {
      output: await switchTo({ output: { ...output, deviceId: otherOutput.id } }, 'output', 'output switch'),
      outputBack: await switchTo({ output }, 'output', 'output switch back'),
      input: await switchTo({ microphone: { ...desired.microphone, deviceId: otherInput.id } }, 'microphone', 'input switch'),
      inputBack: await switchTo({ microphone: { ...desired.microphone, deviceId: null } }, 'microphone', 'input switch back'),
    }
    await sleep(2200)
    report.deviceSwitch.renderedFramesDuring = counter('remote_audio_output_metrics', 'rendered_frames') - renderedBefore
    report.deviceSwitch.microphoneFramesSentDuring = counter('microphone_metrics', 'submitted') - sentBefore
  }

  // Voice while every core is busy: scheduling jitter is what breaks playout.
  const { Worker } = await import('node:worker_threads')
  const load = Array.from({ length: (await import('node:os')).cpus().length }, () =>
    new Worker('for (;;) {}', { eval: true }))
  const loaded = await measure(phaseSeconds)
  for (const worker of load) await worker.terminate()
  report.voiceUnderLoad = {
    cpuPercentOfOneCore: loaded.cpuPercentOfOneCore, ...voiceMetrics(loaded),
  }

  // Watching someone's screen.
  bots.push(bot('streamer', 'bench-a', ['--seconds', String(phaseSeconds * 3), '--screen', '1920x1080@30']))
  let publication
  await waitFor(() => {
    publication = addon.queryInventory().inventory.video.publications.find(value => value.participantIdentity === 'streamer')
    return publication
  }, 15_000, 'remote screen publication')
  const watchStarted = now()
  apply({ rendererId: 'bench-renderer', remoteVideoDemand: [{
    participantIdentity: publication.participantIdentity, publicationId: publication.publicationId }] })
  await waitFor(() => (frames.get(publication.publicationId) ?? 0) > 0, 15_000, 'first remote screen frame')
  const firstFrameMs = Math.round(now() - watchStarted)
  const watchFramesBefore = frames.get(publication.publicationId)
  const watching = await measure(phaseSeconds)
  report.screenView = {
    firstFrameMs, cpuPercentOfOneCore: watching.cpuPercentOfOneCore, threads: watching.threads,
    exportedFps: Number(((frames.get(publication.publicationId) - watchFramesBefore) / (watching.elapsedMs / 1000)).toFixed(1)),
  }
  apply({ rendererId: null, remoteVideoDemand: [] })

  // Sharing the primary monitor at the 1080p30 preset.
  addon.querySources({ revision: 1, kind: 'all' })
  let monitor
  await waitFor(() => {
    const sources = addon.queryInventory().inventory.sources
    monitor = sources.revision === 1 && sources.complete
      ? sources.entries.find(entry => entry.kind === 'monitor' && entry.primary) ?? sources.entries.find(entry => entry.kind === 'monitor')
      : undefined
    return monitor
  }, 10_000, 'monitor source')
  const viewer = bot('viewer', 'bench-a', ['--seconds', String(phaseSeconds + 8), '--watch', self])
  await sleep(1500)
  const shareStarted = now()
  apply({ screen: { state: 'on', sourceId: monitor.id, width: 1920, height: 1080, fps: 30, bitrate: 6_000_000,
    audioMode: 'none', audioBitrate: 128_000, previewRendererId: null, retryRevision: 0, audioRetryRevision: 0 } })
  await waitFor(() => tracks.screen?.state === 'running' || tracks.screen?.state === 'failed', 15_000, 'screen share')
  const shareReadyMs = Math.round(now() - shareStarted)
  // The share picker stays open: sources are re-enumerated every 2 s.
  let sourceRevision = 1
  const picker = setInterval(() => addon.querySources({ revision: ++sourceRevision, kind: 'all' }), 2000)
  const sharing = await measure(phaseSeconds)
  clearInterval(picker)
  report.screenShare = {
    state: tracks.screen?.state, failure: tracks.screen?.failure, runningMs: shareReadyMs,
    cpuPercentOfOneCore: sharing.cpuPercentOfOneCore, threads: sharing.threads,
    pipeline: sharing.delta('screen_video_metrics', ['capture_frames', 'encoder_encoded', 'keyframes',
      'conversion_drops', 'network_backpressure_drops', 'encoder_rejections']),
    lastKeyframeBytes: sharing.metrics.screen_video_metrics?.last_keyframe_bytes,
    publishAgeLastUs: sharing.metrics.screen_video_metrics?.publish_age_last_us,
  }
  apply({ screen: { state: 'off' } })
  report.screenShare.viewer = await viewer.done

  // Sharing one animated application window at the 720p30 preset (WGC).
  const fixture = spawn(fixturePath, [], { stdio: ['pipe', 'pipe', 'ignore'] })
  await new Promise(resolve => fixture.stdout.once('data', resolve))
  addon.querySources({ revision: ++sourceRevision, kind: 'all' })
  let window
  await waitFor(() => {
    const sources = addon.queryInventory().inventory.sources
    window = sources.revision === sourceRevision && sources.complete
      ? sources.entries.find(entry => entry.kind === 'window' && entry.title.includes('Syrnike Source Fixture Primary'))
      : undefined
    return window
  }, 10_000, 'fixture window source')
  const windowViewer = bot('window-viewer', 'bench-a', ['--seconds', String(phaseSeconds + 8), '--watch', self])
  await sleep(1500)
  const windowStarted = now()
  apply({ screen: { state: 'on', sourceId: window.id, width: 1280, height: 720, fps: 30, bitrate: 2_000_000,
    audioMode: 'none', audioBitrate: 128_000, previewRendererId: null, retryRevision: 0, audioRetryRevision: 0 } })
  await waitFor(() => tracks.screen?.revision >= revision &&
    (tracks.screen.state === 'running' || tracks.screen.state === 'failed'), 15_000, 'window share')
  const windowReadyMs = Math.round(now() - windowStarted)
  const windowSharing = await measure(phaseSeconds)
  report.windowShare = {
    state: tracks.screen?.state, failure: tracks.screen?.failure, runningMs: windowReadyMs,
    cpuPercentOfOneCore: windowSharing.cpuPercentOfOneCore,
    pipeline: windowSharing.delta('screen_video_metrics', ['capture_frames', 'encoder_encoded', 'keyframes',
      'conversion_drops', 'network_backpressure_drops', 'encoder_rejections']),
  }
  // The window stops repainting, like a static document, and only then does a
  // viewer join. The sender must still produce a decodable frame for them.
  fixture.stdin.write('freeze\n')
  await sleep(2000)
  report.windowShare.lateViewer = await bot('late-viewer', 'bench-a', ['--seconds', '5', '--watch', self]).done
  // Nothing reaches the compositor, not even a repaint: like a stuck WGC
  // session. The backend asks for a repaint, then recreates the session,
  // whose first frame proves the capture alive.
  fixture.stdin.write('stall\n')
  await sleep(1000)
  const stallStarted = { ...metrics.screen_video_metrics }
  await sleep(12_000)
  report.windowShare.stalledCaptureFrames =
    (metrics.screen_video_metrics?.capture_frames ?? 0) - (stallStarted.capture_frames ?? 0)
  fixture.stdin.write('animate\n')
  // The shared window is minimized and restored: viewers see the track
  // muted (a paused stream) and unmuted, then frames again.
  const pauseViewer = bot('pause-viewer', 'bench-a', ['--seconds', '7', '--watch', self])
  await sleep(2000)
  fixture.stdin.write('minimize\n')
  await sleep(2000)
  fixture.stdin.write('restore\n')
  report.windowShare.pauseViewer = await pauseViewer.done
  // The shared window turns portrait: the stream follows its aspect ratio on
  // the same track, and a watching viewer keeps receiving frames.
  const resizeViewer = bot('resize-viewer', 'bench-a', ['--seconds', '6', '--watch', self])
  await sleep(2000)
  fixture.stdin.write('resize 400 700\n')
  report.windowShare.resizeViewer = await resizeViewer.done
  apply({ screen: { state: 'off' } })
  report.windowShare.viewer = await windowViewer.done
  fixture.kill()

  // Move to another channel where two people talk.
  for (const identity of ['talker-4', 'talker-5'])
    bots.push(bot(identity, 'bench-b', ['--seconds', String(phaseSeconds * 2), '--speak', '1']))
  await sleep(1500)
  const moveStarted = now()
  apply({ room: lease('bench-b') })
  await waitFor(() => room !== 'connected', 5_000, 'leave old channel')
  await waitFor(() => room === 'connected', 15_000, 'move')
  report.move = { connectedMs: Math.round(now() - moveStarted) }
  await waitFor(() => tracks.microphone?.state === 'running' && tracks.output?.state === 'running', 15_000, 'move media')
  report.move.mediaReadyMs = Math.round(now() - moveStarted)
  await waitFor(() => addon.queryInventory().inventory.activeSpeakers.length >= 2, 15_000, 'hearing every talker after move')
  report.move.hearingAllMs = Math.round(now() - moveStarted)

  // Leave.
  if (deadNetworkBeforeLeave) {
    signalingDead = true
    await sleep(500)
  }
  const leaveStarted = now()
  report.leaveStartedAtMs = Math.round(leaveStarted)
  apply({ room: null, microphone, output: { state: 'off' } })
  await waitFor(() => room === 'off' && tracks.output?.state === 'off', 40_000, 'leave')
  report.leaveMs = Math.round(now() - leaveStarted)

  const shutdownStarted = now()
  addon.shutdown(5000)
  report.shutdownMs = Math.round(now() - shutdownStarted)
} catch (error) {
  report.error = error instanceof Error ? error.message : String(error)
  process.exitCode = 1
} finally {
  for (const { child } of bots) child.kill()
  server.kill()
}
const text = JSON.stringify(report, null, 2)
if (options.out) (await import('node:fs')).writeFileSync(options.out, text)
console.log(text)
// Native callbacks keep the event loop referenced after shutdown.
process.exit(process.exitCode ?? 0)
