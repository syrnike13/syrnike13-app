const { execFileSync, spawn } = require('node:child_process')
const dgram = require('node:dgram')
const { existsSync } = require('node:fs')
const http = require('node:http')
const {
  mkdir,
  readFile,
  readdir,
  rm,
  stat,
  unlink,
  writeFile,
} = require('node:fs/promises')
const path = require('node:path')
const { performance } = require('node:perf_hooks')
const net = require('node:net')
const { gzipSync } = require('node:zlib')

const {
  buildContentionArtifact,
  contentionProbeRestartDelayMs,
  linkedVideoReadyDeadlineMs,
  resolveContentionProfile,
} = require('./media-contention-profile.cjs')
const {
  loadLiveKitSession,
  mintLocalLiveKitSession,
  parseLiveKitJoinToken,
} = require('./media-contention-livekit.cjs')
const {
  extractPriorityOutcome,
} = require('./media-priority-experiment.cjs')

const activeRunnerChildren = new Set()

function readSourceProvenance() {
  const repositoryRoot = path.resolve(__dirname, '..', '..', '..')
  const commitSha = execFileSync('git', ['rev-parse', 'HEAD'], {
    cwd: repositoryRoot,
    encoding: 'utf8',
  }).trim()
  const relevantChanges = execFileSync(
    'git',
    [
      'status',
      '--porcelain',
      '--untracked-files=all',
      '--',
      'apps/desktop',
      'packages/desktop-native',
      'packages/platform',
    ],
    { cwd: repositoryRoot, encoding: 'utf8' },
  ).trim()
  return {
    commitSha,
    relevantWorkingTreeDirty: relevantChanges.length > 0,
  }
}

function buildLocalLiveKitServerArguments({ httpPort, tcpPort, udpPort }) {
  for (const [name, value] of Object.entries({ httpPort, tcpPort, udpPort })) {
    if (!Number.isSafeInteger(value) || value <= 0 || value > 65_535) {
      throw new Error(`invalid local LiveKit ${name}`)
    }
  }
  return [
    '--dev',
    '--bind', '127.0.0.1',
    '--port', String(httpPort),
    '--udp-port', String(udpPort),
    '--rtc.tcp_port', String(tcpPort),
  ]
}

function canonicalizeAudioPipeline(value) {
  const required = [
    value?.publisherIdentity,
    value?.viewerIdentity,
    value?.publishReturnSid,
    value?.localPublicationSid,
    value?.remotePublicationSid,
    value?.remoteTrackSid,
  ]
  if (value?.protocolVersion !== 1 ||
      required.some((field) => typeof field !== 'string' || !field) ||
      value.publisherIdentity === value.viewerIdentity ||
      value.localPublicationSid !== value.remotePublicationSid ||
      value.localPublicationSid !== value.remoteTrackSid) {
    return null
  }
  return {
    publisherIdentity: value.publisherIdentity,
    viewerIdentity: value.viewerIdentity,
    publicationSid: value.localPublicationSid,
    remoteTrackSid: value.remoteTrackSid,
  }
}

function canonicalizeVideoPipeline(value) {
  const required = [
    value?.roomName,
    value?.publisherIdentity,
    value?.viewerIdentity,
    value?.publicationSid,
    value?.remoteTrackSid,
  ]
  if (value?.protocolVersion !== 1 ||
      required.some((field) => typeof field !== 'string' || !field) ||
      value.publisherIdentity === value.viewerIdentity ||
      value.publicationSid !== value.remoteTrackSid ||
      !Number.isSafeInteger(value.publicationWidth) ||
      !Number.isSafeInteger(value.publicationHeight) ||
      value.publicationWidth <= 0 || value.publicationWidth > 1_920 ||
      value.publicationHeight <= 0 || value.publicationHeight > 1_080) {
    return null
  }
  return {
    roomName: value.roomName,
    publisherIdentity: value.publisherIdentity,
    viewerIdentity: value.viewerIdentity,
    publicationSid: value.publicationSid,
    remoteTrackSid: value.remoteTrackSid,
    publicationWidth: value.publicationWidth,
    publicationHeight: value.publicationHeight,
  }
}

function hasLinkedVideoPresentation(candidates) {
  return [...candidates.values()].some(
    (candidate) => candidate.captureFrameId && candidate.encodedFrameId &&
      candidate.publicationFrameId && candidate.remoteFrameId &&
      candidate.electronFrameId &&
      candidate.captureFrameId === candidate.encodedFrameId &&
      candidate.captureFrameId === candidate.publicationFrameId &&
      candidate.captureFrameId === candidate.remoteFrameId &&
      candidate.captureFrameId === candidate.electronFrameId &&
      candidate.nativeCaptureTimestampUs ===
        candidate.remoteCaptureTimestampUs,
  )
}

function reserveTcpPort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer()
    server.unref()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      const port = typeof address === 'object' && address ? address.port : 0
      server.close((error) => error ? reject(error) : resolve(port))
    })
  })
}

function reserveUdpPort() {
  return new Promise((resolve, reject) => {
    const socket = dgram.createSocket('udp4')
    socket.unref()
    socket.once('error', reject)
    socket.bind(0, '127.0.0.1', () => {
      const port = socket.address().port
      socket.close(() => resolve(port))
    })
  })
}

async function allocateLocalLiveKitPorts() {
  const [httpPort, tcpPort, udpPort] = await Promise.all([
    reserveTcpPort(),
    reserveTcpPort(),
    reserveUdpPort(),
  ])
  return { httpPort, tcpPort, udpPort }
}

function runBoundedChild(executable, args, timeoutMs = 5_000) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    activeRunnerChildren.add(child)
    let stdout = ''
    let stderr = ''
    const append = (target, chunk) => (target + chunk).slice(-65_536)
    child.stdout.on('data', (chunk) => { stdout = append(stdout, chunk) })
    child.stderr.on('data', (chunk) => { stderr = append(stderr, chunk) })
    const timer = setTimeout(() => {
      child.kill()
      reject(new Error(`bounded child timed out after ${timeoutMs}ms`))
    }, timeoutMs)
    child.once('error', (error) => {
      clearTimeout(timer)
      activeRunnerChildren.delete(child)
      reject(error)
    })
    child.once('exit', (code, signal) => {
      clearTimeout(timer)
      activeRunnerChildren.delete(child)
      if (code !== 0) {
        reject(new Error(
          `bounded child exited ${String(code ?? signal)}: ${stderr.trim()}`,
        ))
        return
      }
      resolve({ stdout, stderr })
    })
  })
}

async function waitForLocalLiveKit(httpPort, child, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error('owned local LiveKit server exited before readiness')
    }
    const ready = await new Promise((resolve) => {
      const request = http.get({
        hostname: '127.0.0.1',
        port: httpPort,
        path: '/',
        timeout: 250,
      }, (response) => {
        response.resume()
        resolve(true)
      })
      request.once('timeout', () => {
        request.destroy()
        resolve(false)
      })
      request.once('error', () => resolve(false))
    })
    if (ready) return
    await delay(50)
  }
  throw new Error('owned local LiveKit server readiness timed out')
}

function contentionPageDataUrl() {
  const html = `<!doctype html>
<meta charset="utf-8">
<title>Syrnike media contention</title>
<style>
  html, body { margin: 0; overflow: hidden; background: #101820; }
  #activity { display: block; width: 100vw; height: 100vh; }
</style>
<canvas id="activity" width="320" height="180"></canvas>
<script>
  const canvas = document.getElementById('activity')
  const context = canvas.getContext('2d', { alpha: false })
  let frame = 0
  function draw() {
    const x = frame % canvas.width
    context.fillStyle = 'rgb(' + (frame * 17 % 255) + ',32,64)'
    context.fillRect(0, 0, canvas.width, canvas.height)
    context.fillStyle = '#ffffff'
    context.fillRect(x, 0, 8, canvas.height)
    frame += 1
    requestAnimationFrame(draw)
  }
  requestAnimationFrame(draw)
</script>`
  return `data:text/html;charset=utf-8,${encodeURIComponent(html)}`
}

function buildContentionWindowOptions(preload) {
  return {
    show: true,
    width: 320,
    height: 180,
    focusable: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    webPreferences: {
      contextIsolation: true,
      sandbox: false,
      backgroundThrottling: false,
      preload,
    },
  }
}

function startContentionWindowMotion(
  window,
  workArea,
  schedule = setInterval,
) {
  const baseX = workArea.x + 32
  const baseY = workArea.y + 32
  window.setBounds({ x: baseX, y: baseY, width: 320, height: 180 })
  let shifted = false
  return schedule(() => {
    shifted = !shifted
    window.setPosition(baseX + (shifted ? 2 : 0), baseY, false)
  }, 16)
}

class BoundedSampleWindow {
  constructor(capacity) {
    this.capacity = positiveInteger(capacity, 1)
    this.samples = []
    this.next = 0
  }

  add(value) {
    if (this.samples.length < this.capacity) {
      this.samples.push(value)
      return
    }
    this.samples[this.next] = value
    this.next = (this.next + 1) % this.capacity
  }

  get size() {
    return this.samples.length
  }

  values() {
    return this.samples
  }
}

async function shutdownChildren(children, options = {}) {
  const deadlineMs = positiveInteger(options.deadlineMs, 2_000)
  const forceAfterMs = Math.min(
    deadlineMs,
    positiveInteger(options.forceAfterMs, Math.min(500, deadlineMs)),
  )
  const startedAt = performance.now()
  const alive = new Map()
  const listeners = new Map()

  for (const child of children) {
    if (!child || child.exitCode !== null || child.signalCode !== null) continue
    const onExit = () => alive.delete(child.pid)
    alive.set(child.pid, child)
    listeners.set(child, onExit)
    child.once('exit', onExit)
    try {
      child.kill()
    } catch {
      // The final alive set is the source of truth for teardown outcome.
    }
  }

  await waitUntil(() => alive.size === 0, forceAfterMs)
  for (const child of alive.values()) {
    try {
      child.kill('SIGKILL')
    } catch {
      // Report an owned process that survives the common deadline.
    }
  }
  const remainingMs = Math.max(
    0,
    deadlineMs - (performance.now() - startedAt),
  )
  await waitUntil(() => alive.size === 0, remainingMs)

  for (const [child, listener] of listeners) {
    child.off('exit', listener)
  }
  return {
    elapsedMs: performance.now() - startedAt,
    orphanPids: [...alive.keys()].sort((left, right) => left - right),
  }
}

async function waitUntil(predicate, timeoutMs) {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || predicate()) return
  const deadline = performance.now() + timeoutMs
  while (!predicate()) {
    const remaining = deadline - performance.now()
    if (remaining <= 0) return
    await new Promise((resolve) => setTimeout(resolve, Math.min(5, remaining)))
  }
}

function positiveInteger(value, fallback) {
  return Number.isSafeInteger(value) && value > 0 ? value : fallback
}

function selectResourceBaselineSummaries(nativeSummaries) {
  return nativeSummaries.filter(
    (summary) => Number(summary.resourceBaselineCaptured) === 1,
  )
}

function resourceBaselinesComplete(nativeSummaries) {
  const captured = selectResourceBaselineSummaries(nativeSummaries)
  return captured.length > 0 && nativeSummaries.every((summary) =>
    Number(summary.republishCount) !== 1 ||
      Number(summary.resourceBaselineCaptured) === 1)
}

function shouldAwaitResourceBaseline(
  hostEpoch,
  linkedStartupEpochs,
  resourceBaselineEpochs,
) {
  return linkedStartupEpochs.has(hostEpoch) &&
    !resourceBaselineEpochs.has(hostEpoch)
}

function contentionCompletionBlockers(state) {
  const blockers = []
  if (!state.voiceTimeoutRecycleCompleted) blockers.push('voice-timeout-recycle')
  if (!state.demandRemovalCompleted) blockers.push('demand-removal')
  if (Number(state.pendingStartup) !== 0) blockers.push('pending-startup')
  if (Number(state.pendingMainOperations) !== 0) {
    blockers.push('pending-main-operations')
  }
  if (Number(state.remoteRendererLeases) !== 0) {
    blockers.push('remote-renderer-leases')
  }
  if (Number(state.remoteGpuGenerations) !== 0) {
    blockers.push('remote-gpu-generations')
  }
  if (!state.resourceBaselineCaptured) blockers.push('resource-baseline')
  return blockers
}

function contentionCompletionDeadlineMs(contracts) {
  const names = [
    'voiceReleaseRecoveryMs',
    'gracefulRetirementMs',
    'replacementPreflightMs',
    'schedulerMs',
  ]
  let total = 0
  for (const name of names) {
    const value = Number(contracts?.[name])
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new Error(`invalid contention completion contract: ${name}`)
    }
    total += value
  }
  return total
}

function contentionProbeDurationMs({
  elapsedMs,
  observationMs,
  completionMs,
  safetyMarginMs,
}) {
  for (const [name, value] of Object.entries({
    elapsedMs,
    observationMs,
    completionMs,
    safetyMarginMs,
  })) {
    if (!Number.isFinite(value) || value < 0) {
      throw new Error(`invalid contention probe duration input: ${name}`)
    }
  }
  return Math.max(
    safetyMarginMs,
    observationMs + completionMs + safetyMarginMs - elapsedMs,
  )
}

function isRetiredRendererRelease(frameEpoch, snapshot) {
  return snapshot?.status !== 'ready' || snapshot?.hostEpoch !== frameEpoch
}

function isBridgeSkippedRetiredRelease(frameEpoch, latestRuntimeEpoch) {
  return Number.isSafeInteger(frameEpoch) &&
    Number.isSafeInteger(latestRuntimeEpoch) &&
    latestRuntimeEpoch > frameEpoch
}

function classifyRuntimeFrameEpoch(frameEpoch, latestRuntimeEpoch) {
  if (!Number.isSafeInteger(frameEpoch) || frameEpoch <= 0 ||
      !Number.isSafeInteger(latestRuntimeEpoch) || latestRuntimeEpoch < 0) {
    return 'invalid'
  }
  if (frameEpoch === latestRuntimeEpoch && latestRuntimeEpoch > 0) {
    return 'current'
  }
  return frameEpoch > latestRuntimeEpoch ? 'pending' : 'retired'
}

function isCorrelatedInjectedRetirement(frameEpoch, state) {
  return (frameEpoch === state.fenceOwnerEpoch &&
      state.rendererFenceRecycleCompleted) ||
    (frameEpoch === state.voiceTimeoutEpoch && state.voiceTimeoutArmed)
}

function assignContentionRecoveryEpochs(state, previousEpoch, nextEpoch) {
  if (!Number.isSafeInteger(nextEpoch) || nextEpoch <= 0) return state
  if (state.fenceOwnerEpoch === null) {
    return { ...state, fenceOwnerEpoch: nextEpoch }
  }
  if (
    previousEpoch === state.fenceOwnerEpoch &&
    !state.rendererFenceRecycleCompleted
  ) {
    return {
      ...state,
      rendererFenceRecycleCompleted: true,
      rendererFenceHostRecycles: state.rendererFenceHostRecycles + 1,
      voiceTimeoutEpoch: state.voiceTimeoutEpoch ?? nextEpoch,
    }
  }
  if (
    state.rendererFenceRecycleCompleted &&
    state.voiceTimeoutEpoch === null &&
    nextEpoch !== state.fenceOwnerEpoch
  ) {
    return { ...state, voiceTimeoutEpoch: nextEpoch }
  }
  if (
    state.voiceTimeoutEpoch !== null &&
    previousEpoch === state.voiceTimeoutEpoch &&
    !state.voiceTimeoutRecycleCompleted
  ) {
    if (state.voiceTimeoutArmed) {
      return {
        ...state,
        voiceControlTimeoutRecycles: state.voiceControlTimeoutRecycles + 1,
        voiceTimeoutRecycleCompleted: true,
      }
    }
    return {
      ...state,
      voiceTimeoutEpoch: nextEpoch,
    }
  }
  return state
}

function contentionObservationElapsedMs(contentionStartedAtMs, nowMs) {
  if (contentionStartedAtMs === null) return 0
  return Math.max(0, nowMs - contentionStartedAtMs)
}

function trackPendingOperation(pending, operation) {
  const owned = Promise.resolve(operation).finally(() => pending.delete(owned))
  pending.add(owned)
  return owned
}

const nativeVideoQueueOverflowPattern =
  /^(?:\[[^\]]+ WARN  libwebrtc::imp::video_stream\] )?native video stream queue overflow; stream_instance=([1-9]\d*) dropped ([1-9]\d*) queued frames$/
const nativeVideoQueueSummaryPattern =
  /^(?:\[[^\]]+ WARN  libwebrtc::imp::video_stream\] )?native video stream queue summary; stream_instance=([1-9]\d*) dropped ([1-9]\d*) queued frames$/

function summarizeNativeVideoQueue(records, context = {}) {
  const streams = new Map()
  const recognizedRecords = []
  const rejectedRecords = new Set()
  const stream = (hostEpoch, instance) => {
    const key = `${hostEpoch}:${instance}`
    let value = streams.get(key)
    if (!value) {
      value = { hostEpoch, records: [], overflowMaximum: 0, summary: null }
      streams.set(key, value)
    }
    return value
  }
  for (const record of records) {
    const overflow = nativeVideoQueueOverflowPattern.exec(record.line)
    const summary = nativeVideoQueueSummaryPattern.exec(record.line)
    const parsed = overflow ?? summary
    if (!parsed) continue
    recognizedRecords.push(record)
    const value = stream(Number(record.hostEpoch), parsed[1])
    value.records.push(record)
    const dropped = Number(parsed[2])
    if (!Number.isSafeInteger(value.hostEpoch) || value.hostEpoch <= 0 ||
        !Number.isSafeInteger(dropped) || dropped <= 0) {
      rejectedRecords.add(record)
      continue
    }
    if (overflow) {
      value.overflowMaximum = Math.max(value.overflowMaximum, dropped)
    } else if (value.summary !== null) {
      for (const candidate of value.records) rejectedRecords.add(candidate)
    } else {
      value.summary = dropped
    }
  }

  const streamsByEpoch = new Map()
  let droppedFrames = 0
  let maximumDroppedFrames = 0
  for (const value of streams.values()) {
    streamsByEpoch.set(
      value.hostEpoch,
      (streamsByEpoch.get(value.hostEpoch) ?? 0) + 1,
    )
    if (value.summary === null || value.overflowMaximum <= 0 ||
        value.overflowMaximum > value.summary) {
      for (const record of value.records) rejectedRecords.add(record)
      continue
    }
    droppedFrames += value.summary
    maximumDroppedFrames = Math.max(maximumDroppedFrames, value.summary)
  }
  for (const [hostEpoch, count] of streamsByEpoch) {
    const maximum = Number(
      context.videoStreamGenerationsByEpoch?.get(hostEpoch) ?? 0,
    )
    if (count <= maximum) continue
    for (const value of streams.values()) {
      if (value.hostEpoch !== hostEpoch) continue
      for (const record of value.records) rejectedRecords.add(record)
    }
  }

  const deliveredFrames = Number(context.deliveredFrames) || 0
  const denominator = droppedFrames + Math.max(0, deliveredFrames)
  return {
    complete: rejectedRecords.size === 0,
    droppedFrames,
    streamsWithDrops: streams.size,
    maximumDroppedFrames,
    dropRatio: denominator > 0 ? droppedFrames / denominator : 0,
    acceptedRecords: new Set(recognizedRecords.filter(
      (record) => !rejectedRecords.has(record),
    )),
    rejectedRecords: [...rejectedRecords],
  }
}

function classifyNativeProbeStderr(records, context = {}) {
  const resetPattern =
    /^\[h264 @ [0-9a-fA-F]+\] Frame num change from \d+ to 0$/
  const resetRecords = records.filter(({ line }) => resetPattern.test(line))
  const linkedRecoveryComplete =
    context.linkedVideoPresented === true &&
    Number(context.freshFramesAfterRecovery) >= 1
  const allowReset =
    linkedRecoveryComplete &&
    resetRecords.length === 1 &&
    Number(resetRecords[0].hostEpoch) > 1
  const queueEvidence = context.nativeVideoQueueEvidence ??
    summarizeNativeVideoQueue(records, context)
  const allowQueue = linkedRecoveryComplete && queueEvidence.complete
  return records.filter((record) => {
    if (resetPattern.test(record.line)) return !allowReset
    if (nativeVideoQueueOverflowPattern.test(record.line) ||
        nativeVideoQueueSummaryPattern.test(record.line)) {
      return !allowQueue || !queueEvidence.acceptedRecords.has(record)
    }
    return true
  })
}

async function runElectronContention(electron, argv = process.argv.slice(2)) {
  const options = parseRunnerOptions(argv)
  const profile = resolveContentionProfile(
    options.profile,
    options.durationMs === undefined ? {} : { durationMs: options.durationMs },
  )
  const completionContracts = {
    voiceReleaseRecoveryMs: 6_500,
    gracefulRetirementMs: 8_000,
    replacementPreflightMs: 5_000,
    schedulerMs: 100,
  }
  const completionDeadlineMs =
    contentionCompletionDeadlineMs(completionContracts)
  const buildDirectory = path.resolve(
    options.buildDirectory ??
      process.env.SYRNIKE_CONTENTION_BUILD_DIR ??
      path.join(__dirname, '..', 'build', 'Release'),
  )
  const outputDirectory = path.resolve(
    options.outputDirectory ??
      path.join(__dirname, '..', 'artifacts', 'media-contention'),
  )
  const liveKitServerExecutable = path.resolve(
    options.liveKitServer ??
      process.env.SYRNIKE_CONTENTION_LIVEKIT_SERVER ??
      '',
  )
  if (!options.liveKitServer &&
      !process.env.SYRNIKE_CONTENTION_LIVEKIT_SERVER) {
    throw new Error(
      'local LiveKit server path is required via --livekit-server or ' +
      'SYRNIKE_CONTENTION_LIVEKIT_SERVER',
    )
  }
  if (!existsSync(liveKitServerExecutable)) {
    throw new Error(`local LiveKit server executable missing: ${liveKitServerExecutable}`)
  }
  process.env.SYRNIKE_MEDIA_PRIORITY_POLICY = options.priorityPolicy
  const diagnosticRunId =
    `contention-${options.priorityPolicy}-${Date.now()}-${process.pid}`
  const diagnosticDirectory = path.join(
    outputDirectory,
    '.diagnostics',
    diagnosticRunId,
  )
  const captureDiagnosticPath = path.join(
    diagnosticDirectory,
    'screen-capture.jsonl',
  )
  const probeDiagnosticPath = path.join(
    diagnosticDirectory,
    'native-probe.jsonl',
  )
  await mkdir(diagnosticDirectory, { recursive: true })
  const executables = {
    streaming: path.join(
      buildDirectory,
      'syrnike-native-screen-streaming-benchmark.exe',
    ),
    probe: path.join(
      buildDirectory,
      'syrnike-native-media-contention-probe.exe',
    ),
  }
  const utilityRuntime = require(path.join(
    __dirname,
    '..',
    '..',
    '..',
    'apps',
    'desktop',
    'out',
    'utility',
    'media-contention-runtime.cjs',
  ))
  const {
    ContentionNativeRuntimeAdapter,
    scheduleAfterProbeRetirement,
  } = require('./media-contention-runtime-adapter.cjs')

  await electron.app.whenReady()
  const window = new electron.BrowserWindow(buildContentionWindowOptions(
    path.join(__dirname, 'media-contention-preload.cjs'),
  ))
  await window.loadURL(contentionPageDataUrl())
  const cameraWindowOptions = {
    ...buildContentionWindowOptions(
      path.join(__dirname, 'media-contention-preload.cjs'),
    ),
    show: false,
    alwaysOnTop: false,
  }
  let cameraWindow = new electron.BrowserWindow(cameraWindowOptions)
  let cameraWindowReady = cameraWindow.loadURL(contentionPageDataUrl())
  const windowMotionTimer = startContentionWindowMotion(
    window,
    electron.screen.getPrimaryDisplay().workArea,
  )

  const evidence = createEvidence(profile)
  const startedAtMs = Date.now()
  let contentionStartedAtMs = null
  const children = []
  const childExits = []
  const deferredUnexpectedExits = []
  const probeDiagnosticPaths = []
  const releaseRequests = new Map()
  const inFlight = new Map()
  const activeRemoteDeliveries = new Set()
  const activeRendererLeaseReleases = new Set()
  const activeHandles = new Map()
  const mainLoopSamples = new BoundedSampleWindow(20_000)
  let mainLoopMaximumMs = 0
  let nextReleaseRequest = 0
  let injectedFenceAssigned = false
  let injectedFenceHits = 0
  let rendererLoopP95Ms = 0
  let rendererLoopP99Ms = 0
  let rendererLoopMaximumMs = 0
  let normalVideoFrameAgeMaxMs = 0
  const normalVideoFrameAgeSamples = new BoundedSampleWindow(20_000)
  let releaseRequestLatencyMaxMs = 0
  let injectedReleaseRecoveryDurationMaxMs = 0
  let injectedReleaseRetirementRecoveries = 0
  let uncorrelatedReleaseRetirements = 0
  let injectedRendererFenceLatencyMaxMs = 0
  let maximumMainPending = 0
  let maximumRetainedBytes = 0
  let prematureTextureReuse = 0
  let nativeSummary = null
  const nativeSummaries = []
  const nativeProbeStderr = []
  const audioEvidenceRecords = []
  const audioPipelineByEpoch = new Map()
  let captureSummary = null
  let competitorSummary = null
  let captureChild = null
  let probeChild = null
  let hardwareH264Observed = false
  let remoteBridge = null
  let cameraBridge = null
  let remoteSupervisor = null
  let currentProbeAdapter = null
  let probeRetirement = Promise.resolve()
  let nextProbeHostEpoch = 0
  let remoteHandleImports = 0
  let cameraPreviewHandleImports = 0
  let cameraPreviewDelayedFenceHits = 0
  let cameraPreviewRendererLosses = 0
  let cameraPreviewFreshFramesAfterLoss = 0
  let cameraPreviewFenceAcks = 0
  let cameraPreviewReleaseFailures = 0
  let finalCameraPreviewFrames = 0
  let finalCameraPreviewUsageBytes = 0
  let finalCameraPreviewUsageGenerations = 0
  let cameraRendererLossScheduled = false
  let cameraRendererLossCompleted = false
  let cameraReplacementReady = false
  let remoteFenceAcks = 0
  let remoteFenceReleaseFailures = 0
  let rendererFenceBlockedTransitions = 0
  let rendererBlockedTimedWakeups = 0
  let remoteVideoPoolRollovers = 0
  let configuredRemoteGpuBytesMax = 0
  let configuredRemoteFourKPoolBytes = 0
  let maximumRemoteGpuGenerations = 0
  let maximumRemoteRendererLeases = 0
  let maximumRemoteRendererGenerations = 0
  let rendererReloadCount = 0
  let rendererFenceHostRecycles = 0
  let voiceControlTimeoutRecycles = 0
  let freshFramesAfterRecovery = 0
  let demandRemovals = 0
  let finalRemoteUsageBytes = 0
  let finalRemoteUsageGenerations = 0
  let finalRemoteRendererLeases = 0
  let finalElectronInFlightTextures = 0
  let finalElectronRetainedTextureBytes = 0
  let heldRemoteFrames = 0
  let fenceOwnerEpoch = null
  let voiceTimeoutEpoch = null
  let voiceTimeoutArmed = false
  let voiceTimeoutReleaseSucceeded = false
  let voiceTimeoutRecycleCompleted = false
  let demandRemovalStarted = false
  let demandRemovalCompleted = false
  let rendererFenceRecycleCompleted = false
  let highestRemoteTimestampBeforeRecycle = 0
  let latestRuntimeEpoch = 0
  let aggregateGpuFaultHits = 0
  let aggregateLiveKitFaultHits = 0
  let aggregateAudioGapHits = 0
  let aggregatePostRecoveryAudioAgeUs = 0
  let aggregateInjectedAudioAgeUs = 0
  let gpuFaultArmRequested = false
  let gpuFaultArmedAfterHeld = 0
  let rolloverWhileHeldProofs = 0
  let gpuFaultForcedTimeouts = 0
  let audioRecoveryArmRequested = false
  let audioRecoveryArmed = false
  let audioRecoveryCompleted = false
  let faultInjectionClosed = false
  const audioRecoverySamples = Array(4).fill(null)
  const audioRecoverySettledIndexes = new Set()
  const remoteFrames = new Map()
  const cameraPreviewFrames = new Map()
  const linkedVideoCandidates = new Map()
  const linkedStartupEpochs = new Set()
  const linkedVideoPresentationEpochs = new Set()
  const resourceBaselineEpochs = new Set()
  const lifecycleStatusByEpoch = new Map()
  const liveKitPipelineByEpoch = new Map()

  const recordTimeline = (record) => {
    const maximum = profile.maximumTimelineRecords * 2
    evidence.timeline.push(record)
    if (evidence.timeline.length <= maximum) return
    const ordinary = evidence.timeline.findIndex(
      (entry) => !entry.anomaly && !entry.reason,
    )
    evidence.timeline.splice(ordinary >= 0 ? ordinary : 0, 1)
  }
  const fail = (error) => {
    const message = error instanceof Error ? error.message : String(error)
    evidence.operationalFailures.push(message)
  }
  if (options.audioPolicyResult) {
    try {
      evidence.audioPolicyMatrix = JSON.parse(
        await readFile(path.resolve(options.audioPolicyResult), 'utf8'),
      )
      evidence.environment.capabilities.audioPolicyMatrix = {
        available: true,
      }
    } catch (error) {
      evidence.environment.capabilities.audioPolicyMatrix = {
        available: false,
        reason: `audio policy result could not be loaded: ${
          error instanceof Error ? error.message : String(error)
        }`,
      }
    }
  }
  const writeChild = (child, command) => {
    if (!child?.stdin?.writable) return false
    try {
      return child.stdin.write(`${command}\n`)
    } catch (error) {
      fail(error)
      return false
    }
  }

  const completeRelease = (key) => {
    const request = releaseRequests.get(key)
    if (!request) return
    releaseRequests.delete(key)
    const durationMs = Math.max(0, Date.now() - request.startedAtMs)
    releaseRequestLatencyMaxMs = Math.max(
      releaseRequestLatencyMaxMs,
      durationMs,
    )
    recordTimeline({
      ...request.correlation,
      event: 'media_timeline',
      stage: 'native_released',
      durationMs,
    })
  }

  electron.ipcMain.on('syrnike-contention-presented', (_event, observation) => {
    if (!observation || !Number.isSafeInteger(observation.sequence)) return
    const key = observation.kind === 'remote'
      ? `remote:${observation.runtimeEpoch}:${observation.sequence}`
      : observation.kind === 'camera'
        ? `camera:${observation.runtimeEpoch}:${observation.sequence}`
      : `${observation.kind}:${observation.sequence}`
    const entry = inFlight.get(key)
    if (!entry) return
    const frameAgeMs = Math.max(0, observation.presentedAtMs - entry.receivedAtMs)
    if (!entry.injected &&
        Date.now() - startedAtMs >= profile.measurementWarmupMs) {
      normalVideoFrameAgeMaxMs = Math.max(
        normalVideoFrameAgeMaxMs,
        frameAgeMs,
      )
      normalVideoFrameAgeSamples.add(frameAgeMs)
    }
    if (observation.kind === 'local') {
      evidence.environment.capabilities.screenCapture = { available: true }
    } else if (observation.kind === 'camera') {
      evidence.environment.capabilities.cameraPreview = { available: true }
      if (cameraReplacementReady) {
        cameraPreviewFreshFramesAfterLoss = Math.max(
          cameraPreviewFreshFramesAfterLoss,
          1,
        )
      }
    } else {
      evidence.environment.capabilities.remoteViewer = { available: true }
    }
    evidence.environment.capabilities.electronSharedTexture = {
      available: true,
    }
    recordTimeline({
      ...entry.correlation,
      event: 'media_timeline',
      stage: 'renderer_presented',
      durationMs: frameAgeMs,
      checksum: observation.rgbChecksum,
    })
    if (observation.kind === 'remote' && entry.correlation.pipelineFrameId) {
      const candidate = linkedVideoCandidates.get(
        `${observation.runtimeEpoch}:${entry.correlation.pipelineFrameId}`,
      )
      if (candidate &&
          candidate.remoteCaptureTimestampUs ===
            entry.correlation.nativeCaptureTimestampUs) {
        candidate.electronFrameId = entry.correlation.pipelineFrameId
        if (hasLinkedVideoPresentation(new Map([['current', candidate]]))) {
          linkedVideoPresentationEpochs.add(observation.runtimeEpoch)
        }
      }
    }
    if (observation.kind === 'remote' && entry.heldOrdinal === 1 &&
      !gpuFaultArmRequested && currentProbeAdapter?.hostEpoch ===
        observation.runtimeEpoch) {
      gpuFaultArmRequested = true
      void currentProbeAdapter.armGpuAfterHeld().then((armed) => {
        if (armed.rendererLeases < 1 || armed.frameSequence < 1) {
          throw new Error('GPU fault was acknowledged without a held renderer lease')
        }
        gpuFaultArmedAfterHeld += 1
        maximumRemoteRendererLeases = Math.max(
          maximumRemoteRendererLeases,
          armed.rendererLeases,
        )
        recordTimeline({
          ...entry.correlation,
          event: 'media_timeline',
          stage: 'gpu_fault_armed_after_held',
          rendererLeases: armed.rendererLeases,
          heldFrameSequence: armed.frameSequence,
        })
      }).catch((error) => fail(`GPU first-held handshake: ${String(error)}`))
    }
  })
  electron.ipcMain.on('syrnike-contention-renderer-loop', (_event, sample) => {
    if (Date.now() - startedAtMs < profile.measurementWarmupMs) return
    rendererLoopP95Ms = Math.max(rendererLoopP95Ms, Number(sample?.p95Ms) || 0)
    rendererLoopP99Ms = Math.max(rendererLoopP99Ms, Number(sample?.p99Ms) || 0)
    rendererLoopMaximumMs = Math.max(
      rendererLoopMaximumMs,
      Number(sample?.maximumMs) || 0,
    )
  })
  electron.ipcMain.on('syrnike-contention-renderer-error', (_event, message) => {
    fail(`renderer: ${String(message)}`)
  })

  const deliverTexture = async (kind, child, frame) => {
    const receivedAtMs = Date.now()
    const trackId = kind === 'local' ? 'local-screen-preview' : 'remote-screen'
    const correlation = {
      sessionId: 'contention-session',
      generation: 7,
      trackId,
      frameSequence: frame.sequence,
      nativeCaptureTimestampUs: frame.timestampUs,
      runtimeEpoch: 2,
    }
    const handleKey = String(frame.ntHandle)
    if (activeHandles.has(handleKey)) prematureTextureReuse += 1
    const injectFence =
      kind === 'remote' &&
      contentionStartedAtMs !== null &&
      !injectedFenceAssigned &&
      Date.now() - contentionStartedAtMs >=
        profile.faultSchedule.electronFenceDelay[0].atMs
    if (injectFence) injectedFenceAssigned = true
    const holdMs = injectFence
      ? profile.faultSchedule.electronFenceDelay[0].durationMs
      : 0
    const ntHandle = Buffer.alloc(8)
    ntHandle.writeBigUInt64LE(BigInt(frame.ntHandle))
    let imported
    try {
      imported = electron.sharedTexture.importSharedTexture({
        textureInfo: {
          pixelFormat: 'bgra',
          codedSize: { width: frame.width, height: frame.height },
          visibleRect: { x: 0, y: 0, width: frame.width, height: frame.height },
          timestamp: frame.timestampUs,
          handle: { ntHandle },
        },
        allReferencesReleased: () => {
          const key = `${kind}:${frame.sequence}`
          const entry = inFlight.get(key)
          if (!entry) return
          const fenceLatencyMs = Math.max(0, Date.now() - entry.importedAtMs)
          if (entry.injected) {
            injectedFenceHits += 1
            injectedRendererFenceLatencyMaxMs = Math.max(
              injectedRendererFenceLatencyMaxMs,
              fenceLatencyMs,
            )
          }
          recordTimeline({
            ...entry.correlation,
            event: 'media_timeline',
            stage: 'renderer_fenced',
            durationMs: fenceLatencyMs,
            ...(entry.injected
              ? { anomaly: true, reason: 'shared-texture-fence' }
              : {}),
          })
          activeHandles.delete(entry.handleKey)
          inFlight.delete(key)
          const requestId = ++nextReleaseRequest
          const requestKey = kind === 'remote'
            ? `remote:${requestId}`
            : `local:${frame.sequence}`
          releaseRequests.set(requestKey, {
            startedAtMs: Date.now(),
            correlation: entry.correlation,
          })
          recordTimeline({
            ...entry.correlation,
            event: 'media_timeline',
            stage: 'native_release_requested',
          })
          if (kind === 'remote') {
            writeChild(child, `RELEASE_REMOTE ${frame.sequence} ${requestId}`)
          } else {
            writeChild(child, `RELEASE ${frame.sequence}`)
          }
        },
      })
    } catch (error) {
      fail(`${kind} shared texture import: ${String(error)}`)
      releaseNativeWithoutImport(kind, child, frame, ++nextReleaseRequest)
      return
    }
    const key = `${kind}:${frame.sequence}`
    const retainedBytes = frame.width * frame.height * 4
    inFlight.set(key, {
      correlation,
      receivedAtMs,
      importedAtMs: Date.now(),
      handleKey,
      retainedBytes,
      injected: injectFence,
    })
    activeHandles.set(handleKey, key)
    maximumMainPending = Math.max(maximumMainPending, inFlight.size)
    maximumRetainedBytes = Math.max(
      maximumRetainedBytes,
      [...inFlight.values()].reduce(
        (sum, entry) => sum + entry.retainedBytes,
        0,
      ),
    )
    recordTimeline({
      ...correlation,
      event: 'media_timeline',
      stage: 'electron_imported',
      durationMs: Math.max(0, Date.now() - receivedAtMs),
    })
    try {
      await electron.sharedTexture.sendSharedTexture(
        {
          frame: window.webContents.mainFrame,
          importedSharedTexture: imported,
        },
        {
          kind,
          sequence: frame.sequence,
          width: frame.width,
          height: frame.height,
          nativeTimestampUs: frame.timestampUs,
          mainSentAtMs: Date.now(),
          holdMs,
        },
      )
      recordTimeline({
        ...correlation,
        event: 'media_timeline',
        stage: 'renderer_handoff',
        durationMs: Math.max(0, Date.now() - receivedAtMs),
      })
    } catch (error) {
      fail(`${kind} renderer handoff: ${String(error)}`)
    } finally {
      imported.release()
    }
  }

  const spawnOwned = (
    name,
    executable,
    args,
    onLine,
    environment = {},
    spawnOptions = {},
  ) => {
    if (!existsSync(executable)) {
      fail(`${name} executable missing: ${executable}`)
      return null
    }
    const child = spawn(executable, args, {
      env: { ...process.env, ...environment },
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    child.name = name
    children.push(child)
    activeRunnerChildren.add(child)
    child.once('exit', () => activeRunnerChildren.delete(child))
    child.once('error', () => activeRunnerChildren.delete(child))
    child.stdin.on('error', (error) => fail(`${name} stdin: ${error.message}`))
    attachLineReader(child.stdout, onLine, (error) => fail(`${name}: ${error}`))
    attachLineReader(
      child.stderr,
      (line) => {
        const trimmed = line.trim()
        if (!trimmed) return
        if (spawnOptions.onStderr) spawnOptions.onStderr(trimmed)
        else if (!spawnOptions.allowStderr) fail(`${name} stderr: ${trimmed}`)
      },
      (error) => fail(`${name}: ${error}`),
    )
    const exit = new Promise((resolve) => {
      child.once('error', (error) => {
        fail(`${name} spawn: ${error.message}`)
        resolve({ code: null, signal: null })
      })
      child.once('exit', (code, signal) => {
        if (code !== 0 && signal === null) {
          if (spawnOptions.deferUnexpectedExit) {
            deferredUnexpectedExits.push({
              name,
              code,
              hostEpoch: spawnOptions.hostEpoch,
            })
          } else {
            fail(`${name} exited with ${String(code)}`)
          }
        }
        resolve({ code, signal })
      })
    })
    child.ownedExit = exit
    childExits.push(exit)
    return child
  }

  const localLiveKitPorts = await allocateLocalLiveKitPorts()
  const localLiveKitUrl =
    `ws://127.0.0.1:${localLiveKitPorts.httpPort}`
  const liveKitSession = options.liveKitParticipantsFile
    ? loadLiveKitSession(
      await readFile(path.resolve(options.liveKitParticipantsFile), 'utf8'),
    )
    : await mintLocalLiveKitSession(liveKitServerExecutable, {
      runChild: runBoundedChild,
      roomName: options.liveKitRoom,
    })
  if (options.liveKitRoom && options.liveKitRoom !== liveKitSession.roomName) {
    throw new Error('livekit room does not match participants file')
  }
  const localLiveKitRoom = liveKitSession.roomName
  const localLiveKitParticipants = liveKitSession.participants
  const localLiveKitServer = spawnOwned(
    'local-livekit-server',
    liveKitServerExecutable,
    buildLocalLiveKitServerArguments(localLiveKitPorts),
    () => {},
    {},
    { allowStderr: true },
  )
  if (!localLiveKitServer) {
    throw new Error('owned local LiveKit server could not start')
  }
  await waitForLocalLiveKit(
    localLiveKitPorts.httpPort,
    localLiveKitServer,
  )

  const remoteFrameKey = (runtimeEpoch, sequence) =>
    `remote:${runtimeEpoch}:${sequence}`
  const cameraPreviewFrameKey = (runtimeEpoch, sequence) =>
    `camera:${runtimeEpoch}:${sequence}`
  const frameCorrelation = (frame) => ({
    sessionId: frame.sessionId,
    generation: frame.generation,
    trackId: frame.trackId,
    frameSequence: frame.sequence,
    nativeCaptureTimestampUs: frame.sourceTimestampUs || frame.timestampUs,
    runtimeEpoch: frame.runtimeEpoch,
    ...(frame.pipelineFrameId
      ? { pipelineFrameId: frame.pipelineFrameId }
      : {}),
  })

  const handleProbeProtocol = (adapter, line) => {
    const parsed = parsePrefixedJson(line)
    if (!parsed) return
    const { prefix, value } = parsed
    if (prefix === 'CAPABILITY') {
      const capability = value.name === 'remoteViewer'
        ? 'nativeRemoteTexturePool'
        : value.name
      evidence.environment.capabilities[capability] = {
        available: value.available === true,
        ...(value.reason ? { reason: value.reason } : {}),
      }
      return
    }
    if (prefix === 'REMOTE_FRAME') {
      const delivery = trackPendingOperation(
        activeRemoteDeliveries,
        deliverRemoteFrame(adapter, value),
      )
      maximumMainPending = Math.max(
        maximumMainPending,
        inFlight.size + releaseRequests.size + activeRemoteDeliveries.size +
          activeRendererLeaseReleases.size,
      )
      void delivery
      return
    }
    if (prefix === 'CAMERA_FRAME') {
      const delivery = trackPendingOperation(
        activeRemoteDeliveries,
        deliverCameraPreviewFrame(adapter, value),
      )
      maximumMainPending = Math.max(
        maximumMainPending,
        inFlight.size + releaseRequests.size + activeRemoteDeliveries.size +
          activeRendererLeaseReleases.size,
      )
      void delivery
      return
    }
    if (prefix === 'VIDEO_HANDOFF') {
      if (value.protocolVersion !== 1 ||
          typeof value.captureFrameId !== 'string' ||
          value.encodedFrameId !== value.captureFrameId ||
          value.publicationFrameId !== value.captureFrameId ||
          value.source !== 'ScreenActor/D3D11H264VideoSource' ||
          !Number.isSafeInteger(value.captureTimestampUs)) {
        fail('native linked video handoff used an invalid protocol record')
        return
      }
      linkedVideoCandidates.set(
        `${adapter.hostEpoch}:${value.captureFrameId}`,
        {
        captureFrameId: value.captureFrameId,
        encodedFrameId: value.encodedFrameId,
        publicationFrameId: value.publicationFrameId,
        nativeCaptureTimestampUs: value.captureTimestampUs,
        ...(liveKitPipelineByEpoch.get(adapter.hostEpoch) ?? {}),
        },
      )
      return
    }
    if (prefix === 'LIVEKIT_PIPELINE') {
      const pipeline = canonicalizeVideoPipeline(value)
      if (!pipeline) {
        fail('native LiveKit pipeline used an invalid protocol record')
        return
      }
      liveKitPipelineByEpoch.set(adapter.hostEpoch, pipeline)
      for (const [key, candidate] of linkedVideoCandidates) {
        if (key.startsWith(`${adapter.hostEpoch}:`)) {
          Object.assign(candidate, pipeline)
        }
      }
      return
    }
    if (prefix === 'AUDIO_PLAYOUT') {
      audioEvidenceRecords.push({
        ...value,
        hostEpoch: adapter.hostEpoch,
        ...(audioPipelineByEpoch.get(adapter.hostEpoch) ?? {}),
      })
      return
    }
    if (prefix === 'AUDIO_PIPELINE') {
      const pipeline = canonicalizeAudioPipeline(value)
      if (!pipeline) {
        fail(
          'native remote audio pipeline used an invalid canonical SID record ' +
          `(return=${String(value.publishReturnSid)}, ` +
          `local=${String(value.localPublicationSid)}, ` +
          `remotePublication=${String(value.remotePublicationSid)}, ` +
          `remoteTrack=${String(value.remoteTrackSid)})`,
        )
        return
      }
      audioPipelineByEpoch.set(adapter.hostEpoch, pipeline)
      for (const record of audioEvidenceRecords) {
        if (record.hostEpoch === adapter.hostEpoch) {
          Object.assign(record, pipeline)
        }
      }
      return
    }
    if (prefix === 'BRIDGE_STATUS') {
      if (value.state === 'fence-blocked') {
        rendererFenceBlockedTransitions += 1
      }
      rendererBlockedTimedWakeups = Math.max(
        rendererBlockedTimedWakeups,
        Number(value.wakeDelta) || 0,
      )
      remoteVideoPoolRollovers = Math.max(
        remoteVideoPoolRollovers,
        Number(value.gpuPoolRollovers) || 0,
      )
      configuredRemoteGpuBytesMax = Math.max(
        configuredRemoteGpuBytesMax,
        Number(value.configuredRemoteGpuBytes) || 0,
      )
      maximumRemoteGpuGenerations = Math.max(
        maximumRemoteGpuGenerations,
        Number(value.remoteGpuGenerations) || 0,
      )
      maximumRemoteRendererLeases = Math.max(
        maximumRemoteRendererLeases,
        Number(value.rendererLeases) || 0,
      )
      maximumRemoteRendererGenerations = Math.max(
        maximumRemoteRendererGenerations,
        Number(value.rendererGenerations) || 0,
      )
      recordTimeline({
        event: 'media_timeline',
        stage: value.state,
        sessionId: 'contention-session',
        generation: 7,
        trackId: 'contention-remote',
        runtimeEpoch: adapter.hostEpoch,
        ...(value.state === 'fence-blocked'
          ? { anomaly: true, reason: 'renderer-fence-blocked' }
          : {}),
        ...value,
      })
      return
    }
    if (prefix === 'RESOURCE_BASELINE_SAMPLE') {
      if (Number(value.linkedVideoDelivered) === 1) {
        linkedStartupEpochs.add(adapter.hostEpoch)
      }
      if (Number(value.stableSamples) >= 10) {
        resourceBaselineEpochs.add(adapter.hostEpoch)
      }
      recordTimeline({
        event: 'media_timeline',
        stage: 'resource_baseline_sample',
        runtimeEpoch: adapter.hostEpoch,
        ...value,
      })
      return
    }
    if (prefix === 'LIFECYCLE_STATUS') {
      lifecycleStatusByEpoch.set(adapter.hostEpoch, value)
      recordTimeline({
        event: 'media_timeline',
        stage: 'lifecycle_status',
        runtimeEpoch: adapter.hostEpoch,
        ...value,
      })
      return
    }
    if (prefix === 'PUBLICATION_TEARDOWN') {
      recordTimeline({
        event: 'media_timeline',
        stage: 'publication_teardown',
        runtimeEpoch: adapter.hostEpoch,
        ...value,
      })
      if (value.phase === 'timeout') {
        fail(
          `native-probe-epoch-${adapter.hostEpoch} publication teardown ` +
          `retained ${String(value.pendingPublication)} operations`,
        )
      }
      return
    }
    if (prefix === 'PUBLICATION_LIFECYCLE') {
      recordTimeline({
        event: 'media_timeline',
        stage: 'publication_lifecycle',
        runtimeEpoch: adapter.hostEpoch,
        ...value,
      })
      return
    }
    if (prefix === 'RESOURCE_ATTRIBUTION') {
      recordTimeline({
        event: 'media_timeline',
        stage: 'resource_attribution',
        runtimeEpoch: adapter.hostEpoch,
        anomaly: true,
        reason: 'resource-threshold-crossed',
        ...value,
      })
      return
    }
    if (prefix === 'ROLLOVER_WHILE_HELD') {
      if ((Number(value.rendererLeases) || 0) < 1 ||
        (Number(value.remoteGpuGenerations) || 0) !== 2 ||
        (Number(value.forcedTimeouts) || 0) < 1 ||
        (Number(value.forcedTimeouts) || 0) > 4) {
        fail('native rollover acknowledgement had no retained renderer generation')
        return
      }
      rolloverWhileHeldProofs += 1
      gpuFaultForcedTimeouts = Math.max(
        gpuFaultForcedTimeouts,
        Number(value.forcedTimeouts) || 0,
      )
      remoteVideoPoolRollovers = Math.max(
        remoteVideoPoolRollovers,
        Number(value.gpuPoolRollovers) || 0,
      )
      maximumRemoteGpuGenerations = Math.max(
        maximumRemoteGpuGenerations,
        Number(value.remoteGpuGenerations) || 0,
      )
      maximumRemoteRendererLeases = Math.max(
        maximumRemoteRendererLeases,
        Number(value.rendererLeases) || 0,
      )
      recordTimeline({
        event: 'media_timeline',
        stage: 'rollover_while_held',
        sessionId: 'contention-session',
        generation: 7,
        trackId: 'contention-remote',
        runtimeEpoch: adapter.hostEpoch,
        anomaly: true,
        reason: 'gpu-completion-rollover-with-held-fence',
        ...value,
      })
      return
    }
    if (prefix === 'FAULT') {
      if (value.name === 'gpuCompletionDelay' && value.phase === 'observed') {
        aggregateGpuFaultHits += 1
      } else if (value.name === 'liveKitCallbackHold' &&
        value.phase === 'released') {
        aggregateLiveKitFaultHits += 1
      } else if (value.name === 'audioSchedulingGap' &&
        value.phase === 'recovered') {
        const index = Number(value.index)
        if (!Number.isSafeInteger(index) || index < 0 ||
          index >= audioRecoverySamples.length) {
          fail(`audio recovery returned invalid sample index ${String(value.index)}`)
          return
        }
        audioRecoverySamples[index] = {
          index,
          scheduledPlayoutAgeUs:
            Number(value.scheduledPlayoutAgeUs) || 0,
          injectedScheduledPlayoutAgeUs:
            Number(value.injectedScheduledPlayoutAgeUs) || 0,
        }
        aggregateAudioGapHits = audioRecoverySamples.filter(Boolean).length
        audioRecoveryCompleted = aggregateAudioGapHits ===
            audioRecoverySamples.length &&
          audioRecoverySettledIndexes.size === audioRecoverySamples.length
        aggregatePostRecoveryAudioAgeUs = Math.max(
          aggregatePostRecoveryAudioAgeUs,
          Number(value.scheduledPlayoutAgeUs) || 0,
        )
        aggregateInjectedAudioAgeUs = Math.max(
          aggregateInjectedAudioAgeUs,
          Number(value.injectedScheduledPlayoutAgeUs) || 0,
        )
      } else if (value.name === 'audioSchedulingGap' &&
        value.phase === 'settled') {
        const index = Number(value.index)
        if (!Number.isSafeInteger(index) || index < 0 ||
          index >= audioRecoverySamples.length ||
          !audioRecoverySamples[index]) {
          fail(`audio recovery settled invalid sample index ${String(value.index)}`)
          return
        }
        audioRecoverySettledIndexes.add(index)
        audioRecoveryCompleted = aggregateAudioGapHits ===
            audioRecoverySamples.length &&
          audioRecoverySettledIndexes.size === audioRecoverySamples.length
      }
      return
    }
    if (prefix === 'TIMELINE') {
      recordTimeline({ ...value, runtimeEpoch: adapter.hostEpoch })
      return
    }
    if (prefix === 'SUMMARY') {
      nativeSummary = value
      nativeSummaries.push({ ...value, hostEpoch: adapter.hostEpoch })
      recordTimeline({
        event: 'media_timeline',
        stage: 'native_terminal_summary',
        runtimeEpoch: adapter.hostEpoch,
        ...value,
      })
      audioEvidenceRecords.push({
        ...value,
        hostEpoch: adapter.hostEpoch,
        evidenceSequence: Number.MAX_SAFE_INTEGER,
        ...(audioPipelineByEpoch.get(adapter.hostEpoch) ?? {}),
      })
      configuredRemoteFourKPoolBytes = Math.max(
        configuredRemoteFourKPoolBytes,
        Number(value.configuredRemoteFourKPoolBytes) || 0,
      )
      configuredRemoteGpuBytesMax = Math.max(
        configuredRemoteGpuBytesMax,
        Number(value.configuredRemoteGpuBytesMax) || 0,
      )
      maximumRemoteGpuGenerations = Math.max(
        maximumRemoteGpuGenerations,
        Number(value.maximumRemoteGpuGenerations) || 0,
      )
      maximumRemoteRendererLeases = Math.max(
        maximumRemoteRendererLeases,
        Number(value.maximumRemoteRendererLeases) || 0,
      )
      maximumRemoteRendererGenerations = Math.max(
        maximumRemoteRendererGenerations,
        Number(value.maximumRemoteRendererGenerations) || 0,
      )
      finalRemoteUsageBytes = Number(value.finalRemoteUsageBytes) || 0
      finalRemoteUsageGenerations =
        Number(value.finalRemoteUsageGenerations) || 0
      finalRemoteRendererLeases =
        Number(value.finalRemoteRendererLeases) || 0
      finalCameraPreviewFrames =
        Number(value.finalCameraPreviewFrames) || 0
      finalCameraPreviewUsageBytes =
        Number(value.finalCameraPreviewUsageBytes) || 0
      finalCameraPreviewUsageGenerations =
        Number(value.finalCameraPreviewUsageGenerations) || 0
      return
    }
    if (prefix === 'FINISH_ACK') {
      recordTimeline({
        event: 'media_timeline',
        stage: 'probe_finish_acknowledged',
        runtimeEpoch: adapter.hostEpoch,
        elapsedMs: Date.now() - startedAtMs,
      })
    }
    adapter.handleProtocol(prefix, value)
  }

  const probeArgumentsForEpoch = (elapsedMs, hostEpoch) => {
    const participant = localLiveKitParticipants[hostEpoch - 1]
    if (!participant) {
      throw new Error(`local LiveKit participant epoch exhausted: ${hostEpoch}`)
    }
    const remainingMs = contentionProbeDurationMs({
      elapsedMs,
      observationMs: profile.durationMs,
      completionMs: completionDeadlineMs,
      safetyMarginMs: completionContracts.replacementPreflightMs,
    })
    const argumentForUnobservedFault = (fault, observed) => observed > 0
      ? `${remainingMs + 1_000}:${fault.durationMs}`
      : `${Math.max(1, fault.atMs - elapsedMs)}:${fault.durationMs}`
    const args = [
      '--electron-pid',
      String(process.pid),
      '--duration-ms',
      String(remainingMs),
      '--gpu-fault',
      `0:${profile.faultSchedule.gpuCompletionDelay[0].durationMs}`,
      '--livekit-fault',
      argumentForUnobservedFault(
        profile.faultSchedule.liveKitCallbackHold[0],
        aggregateLiveKitFaultHits,
      ),
      '--livekit-url',
      localLiveKitUrl,
      '--publisher-identity',
      participant.publisherIdentity,
      '--viewer-identity',
      participant.viewerIdentity,
      '--room-name',
      localLiveKitRoom,
      '--screen-start-ms',
      '100',
      '--livekit-fault-enabled',
      hostEpoch > 1 && aggregateLiveKitFaultHits === 0 ? '1' : '0',
      '--camera-preview-enabled',
      options.probeCameraPreviewEnabled === false ? '0' : '1',
    ]
    const remainingGaps = profile.faultSchedule.audioSchedulingGap.slice(
      aggregateAudioGapHits,
    )
    if (remainingGaps.length === 0) {
      args.push('--audio-gap', `${remainingMs + 1_000}:1`)
    } else {
      for (const gap of remainingGaps) {
        args.push(
          '--audio-gap',
          `${gap.afterArmMs}:${gap.durationMs}`,
        )
      }
    }
    args.push('--audio-index-base', String(aggregateAudioGapHits))
    return args
  }

  const createProbeAdapter = () => {
    const hostEpoch = ++nextProbeHostEpoch
    const diagnosticPath = `${probeDiagnosticPath}.epoch-${hostEpoch}`
    probeDiagnosticPaths.push(diagnosticPath)
    let adapter = null
    const child = spawnOwned(
      `native-probe-epoch-${hostEpoch}`,
      executables.probe,
      probeArgumentsForEpoch(
        contentionObservationElapsedMs(contentionStartedAtMs, Date.now()),
        hostEpoch,
      ),
      (line) => {
        if (adapter) handleProbeProtocol(adapter, line)
      },
      {
        ...mediaPriorityPolicyEnvironment(options.priorityPolicy),
        SYRNIKE_NATIVE_DIAGNOSTIC_RUN_ID: `${diagnosticRunId}-${hostEpoch}`,
        SYRNIKE_NATIVE_MEDIA_LOG_PATH: diagnosticPath,
        SYRNIKE_CONTENTION_PUBLISHER_TOKEN:
          localLiveKitParticipants[hostEpoch - 1].publisherToken,
        SYRNIKE_CONTENTION_VIEWER_TOKEN:
          localLiveKitParticipants[hostEpoch - 1].viewerToken,
      },
      {
        allowStderr: true,
        deferUnexpectedExit: true,
        hostEpoch,
        onStderr: (line) => nativeProbeStderr.push({
          hostEpoch,
          line,
          beforeFirstPresentation:
            !linkedVideoPresentationEpochs.has(hostEpoch),
        }),
      },
    )
    if (!child) throw new Error('native contention probe could not start')
    recordTimeline({
      event: 'media_timeline',
      stage: 'probe_process_spawned',
      runtimeEpoch: hostEpoch,
      pid: child.pid,
      elapsedMs: Date.now() - startedAtMs,
    })
    adapter = new ContentionNativeRuntimeAdapter({
      child,
      hostEpoch,
      contractVersion: utilityRuntime.NATIVE_RUNTIME_CONTRACT_VERSION,
      write: writeChild,
      gracefulShutdownTimeoutMs: 8_000,
      onKilled: (retiredAdapter) => {
        const retirementStartedAtMs = Date.now()
        recordTimeline({
          event: 'media_timeline',
          stage: 'probe_retirement_requested',
          runtimeEpoch: retiredAdapter.hostEpoch,
          elapsedMs: retirementStartedAtMs - startedAtMs,
        })
        probeRetirement = retiredAdapter.waitForExit().then(() => {
          recordTimeline({
            event: 'media_timeline',
            stage: 'probe_process_exited',
            runtimeEpoch: retiredAdapter.hostEpoch,
            elapsedMs: Date.now() - startedAtMs,
            durationMs: Date.now() - retirementStartedAtMs,
          })
        })
      },
      onGracefulShutdownTimeout: () => {
        fail(
          `native-probe-epoch-${hostEpoch} graceful shutdown ` +
          'exceeded 8000ms',
        )
      },
    })
    currentProbeAdapter = adapter
    probeChild = child
    return adapter
  }

  const importRemoteTexture = ({ textureInfo, allReferencesReleased }) => {
    const frame = remoteFrames.get(Number(textureInfo.timestamp))
    if (!frame) throw new Error('remote frame identity was not staged for import')
    const key = remoteFrameKey(frame.runtimeEpoch, frame.sequence)
    const entry = inFlight.get(key)
    if (!entry) throw new Error('remote frame retention entry is missing')
    const handleKey = String(frame.rawNtHandle)
    if (activeHandles.has(handleKey)) prematureTextureReuse += 1
    activeHandles.set(handleKey, key)
    remoteHandleImports += 1
    return electron.sharedTexture.importSharedTexture({
      textureInfo,
        allReferencesReleased: () => {
        const current = inFlight.get(key)
        if (current) {
          const latencyMs = Math.max(0, Date.now() - current.importedAtMs)
          if (current.injected) {
            injectedFenceHits += 1
            injectedRendererFenceLatencyMaxMs = Math.max(
              injectedRendererFenceLatencyMaxMs,
              latencyMs,
            )
          }
          recordTimeline({
            ...current.correlation,
            event: 'media_timeline',
            stage: 'renderer_fenced',
            durationMs: latencyMs,
            ...(current.injected
              ? { anomaly: true, reason: 'shared-texture-fence' }
              : {}),
          })
          if (isBridgeSkippedRetiredRelease(frame.runtimeEpoch, latestRuntimeEpoch)) {
            if (isCorrelatedInjectedRetirement(frame.runtimeEpoch, {
              fenceOwnerEpoch,
              rendererFenceRecycleCompleted,
              voiceTimeoutEpoch,
              voiceTimeoutArmed,
            })) {
              injectedReleaseRetirementRecoveries += 1
            } else {
              uncorrelatedReleaseRetirements += 1
            }
          }
          activeHandles.delete(handleKey)
          inFlight.delete(key)
        }
        allReferencesReleased()
      },
    })
  }

  const sendRemoteTexture = async (target, metadata) => {
    const frame = remoteFrames.get(Number(metadata.nativeCaptureTimestampUs))
    if (!frame) throw new Error('remote frame metadata was not staged for send')
    const key = remoteFrameKey(frame.runtimeEpoch, frame.sequence)
    const entry = inFlight.get(key)
    const injectFence = frame.runtimeEpoch === fenceOwnerEpoch &&
      !faultInjectionClosed &&
      contentionStartedAtMs !== null &&
      shouldInjectRemoteRendererFence(
        heldRemoteFrames,
        rolloverWhileHeldProofs,
      ) &&
      Date.now() - contentionStartedAtMs >=
        profile.faultSchedule.electronFenceDelay[0].atMs
    if (injectFence) {
      heldRemoteFrames += 1
      entry.injected = true
      entry.heldOrdinal = heldRemoteFrames
    }
    return electron.sharedTexture.sendSharedTexture(target, {
      ...metadata,
      kind: 'remote',
      width: frame.width,
      height: frame.height,
      nativeTimestampUs: frame.timestampUs,
      mainSentAtMs: Date.now(),
      holdMs: injectFence
        ? profile.rendererFenceRecovery.retainedFenceMs
        : 0,
    })
  }

  const releaseRemoteFrameOwned = async (frame) => {
    const startedAt = Date.now()
    recordTimeline({
      ...frameCorrelation(frame),
      event: 'media_timeline',
      stage: 'native_release_requested',
    })
    try {
      await utilityRuntime.runRendererLeaseRelease(remoteSupervisor, {
        type: 'releaseRemoteVideoFrame',
        sessionId: frame.sessionId,
        generation: frame.generation,
        trackId: frame.trackId,
        sequence: frame.sequence,
      })
      const latencyMs = Math.max(0, Date.now() - startedAt)
      const releaseSnapshot = remoteSupervisor.getSnapshot()
      if (isRetiredRendererRelease(frame.runtimeEpoch, releaseSnapshot)) {
        const correlatedRecovery =
          isCorrelatedInjectedRetirement(frame.runtimeEpoch, {
            fenceOwnerEpoch,
            rendererFenceRecycleCompleted,
            voiceTimeoutEpoch,
            voiceTimeoutArmed,
          })
        if (correlatedRecovery) {
          injectedReleaseRetirementRecoveries += 1
          injectedReleaseRecoveryDurationMaxMs = Math.max(
            injectedReleaseRecoveryDurationMaxMs,
            latencyMs,
          )
        } else {
          uncorrelatedReleaseRetirements += 1
        }
        recordTimeline({
          ...frameCorrelation(frame),
          event: 'media_timeline',
          stage: 'native_release_owner_retired',
          durationMs: latencyMs,
          anomaly: true,
          reason: correlatedRecovery
            ? 'injected-host-recovery'
            : 'uncorrelated-host-retirement',
        })
        return
      }
      releaseRequestLatencyMaxMs = Math.max(releaseRequestLatencyMaxMs, latencyMs)
      if (frame.runtimeEpoch === latestRuntimeEpoch) remoteFenceAcks += 1
      if (frame.runtimeEpoch === voiceTimeoutEpoch) {
        voiceTimeoutReleaseSucceeded = true
      }
      recordTimeline({
        ...frameCorrelation(frame),
        event: 'media_timeline',
        stage: 'native_released',
        durationMs: latencyMs,
      })
    } catch (error) {
      remoteFenceReleaseFailures += 1
      recordTimeline({
        ...frameCorrelation(frame),
        event: 'media_timeline',
        stage: 'native_release_timeout',
        durationMs: Math.max(0, Date.now() - startedAt),
        anomaly: true,
        reason: 'voice-control-timeout',
      })
    }
  }

  const releaseRemoteFrame = (frame) => {
    const owned = trackPendingOperation(
      activeRendererLeaseReleases,
      releaseRemoteFrameOwned(frame),
    )
    maximumMainPending = Math.max(
      maximumMainPending,
      inFlight.size + releaseRequests.size + activeRemoteDeliveries.size +
        activeRendererLeaseReleases.size,
    )
    return owned
  }

  const deliverRemoteFrame = async (adapter, value) => {
    if (!remoteBridge) return
    if (classifyRuntimeFrameEpoch(
      adapter.hostEpoch,
      latestRuntimeEpoch,
    ) === 'pending' && adapter === currentProbeAdapter) {
      await waitUntil(
        () => adapter.hostEpoch === latestRuntimeEpoch ||
          adapter !== currentProbeAdapter,
        5_000,
      )
    }
    if (adapter !== currentProbeAdapter ||
        classifyRuntimeFrameEpoch(
          adapter.hostEpoch,
          latestRuntimeEpoch,
        ) !== 'current') return
    const ntHandle = Buffer.alloc(8)
    ntHandle.writeBigUInt64LE(BigInt(value.ntHandle))
    const frame = {
      sessionId: value.sessionId,
      generation: value.generation,
      trackId: value.trackId,
      participantIdentity: value.participantIdentity,
      source: value.source,
      local: false,
      sequence: value.sequence,
      width: value.width,
      height: value.height,
      timestampUs: value.timestampUs,
      sourceTimestampUs: Number(value.sourceTimestampUs) || 0,
      runtimeEpoch: adapter.hostEpoch,
      ntHandle,
      rawNtHandle: value.ntHandle,
      pipelineFrameId: typeof value.pipelineFrameId === 'string'
        ? value.pipelineFrameId
        : '',
    }
    if (frame.pipelineFrameId) {
      const candidate = linkedVideoCandidates.get(
        `${adapter.hostEpoch}:${frame.pipelineFrameId}`,
      )
      if (candidate &&
          candidate.nativeCaptureTimestampUs === frame.sourceTimestampUs) {
        candidate.remoteFrameId = frame.pipelineFrameId
        candidate.remoteCaptureTimestampUs = frame.sourceTimestampUs
      }
    }
    if (frame.runtimeEpoch === fenceOwnerEpoch) {
      highestRemoteTimestampBeforeRecycle = Math.max(
        highestRemoteTimestampBeforeRecycle,
        frame.timestampUs,
      )
    } else if (rendererFenceRecycleCompleted &&
      frame.timestampUs > highestRemoteTimestampBeforeRecycle) {
      freshFramesAfterRecovery = Math.max(freshFramesAfterRecovery, 1)
    }
    if (frame.runtimeEpoch === voiceTimeoutEpoch &&
      audioRecoveryCompleted && voiceTimeoutReleaseSucceeded &&
      !voiceTimeoutArmed) {
      voiceTimeoutArmed = adapter.injectReleaseTimeout()
    }
    if (rendererFenceRecycleCompleted && frame.runtimeEpoch === voiceTimeoutEpoch &&
      !audioRecoveryArmRequested) {
      audioRecoveryArmRequested = true
      try {
        await adapter.armAudioRecovery()
        audioRecoveryArmed = true
        recordTimeline({
          ...frameCorrelation(frame),
          event: 'media_timeline',
          stage: 'audio_recovery_armed_after_renderer_reopen',
        })
      } catch (error) {
        audioRecoveryArmRequested = false
        fail(`audio recovery arm: ${String(error)}`)
      }
    }
    const key = remoteFrameKey(frame.runtimeEpoch, frame.sequence)
    const correlation = frameCorrelation(frame)
    inFlight.set(key, {
      correlation,
      receivedAtMs: Date.now(),
      importedAtMs: Date.now(),
      handleKey: String(value.ntHandle),
      retainedBytes: frame.width * frame.height * 4,
      injected: false,
    })
    maximumMainPending = Math.max(maximumMainPending, inFlight.size)
    maximumRetainedBytes = Math.max(
      maximumRetainedBytes,
      [...inFlight.values()].reduce(
        (sum, retained) => sum + retained.retainedBytes,
        0,
      ),
    )
    remoteFrames.set(frame.timestampUs, frame)
    try {
      const delivered = await remoteBridge.deliver(frame)
      if (!delivered && !activeHandles.has(String(value.ntHandle))) {
        inFlight.delete(key)
      }
    } catch (error) {
      inFlight.delete(key)
      fail(`remote bridge delivery: ${String(error)}`)
    } finally {
      remoteFrames.delete(frame.timestampUs)
    }

    if (voiceTimeoutRecycleCompleted && !demandRemovalStarted &&
      frame.runtimeEpoch === latestRuntimeEpoch) {
      demandRemovalStarted = true
      try {
        await remoteSupervisor.request({
          type: 'setRemoteVideoDemand',
          sessionId: frame.sessionId,
          generation: frame.generation,
          trackId: frame.trackId,
          demanded: false,
        }, 2_000, { probeOnTimeout: true })
        remoteBridge.removeTrack(frame.sessionId, frame.generation, frame.trackId)
        demandRemovals += 1
        demandRemovalCompleted = true
      } catch (error) {
        fail(`remote demand removal: ${String(error)}`)
      }
    }
  }

  const importCameraPreviewTexture = ({ textureInfo, allReferencesReleased }) => {
    const frame = cameraPreviewFrames.get(Number(textureInfo.timestamp))
    if (!frame) {
      throw new Error('camera preview identity was not staged for import')
    }
    const key = cameraPreviewFrameKey(frame.runtimeEpoch, frame.sequence)
    const entry = inFlight.get(key)
    if (!entry) throw new Error('camera preview retention entry is missing')
    const handleKey = String(frame.rawNtHandle)
    if (activeHandles.has(handleKey)) prematureTextureReuse += 1
    activeHandles.set(handleKey, key)
    cameraPreviewHandleImports += 1
    return electron.sharedTexture.importSharedTexture({
      textureInfo,
      allReferencesReleased: () => {
        const current = inFlight.get(key)
        if (current) {
          const latencyMs = Math.max(0, Date.now() - current.importedAtMs)
          if (current.injected) {
            cameraPreviewDelayedFenceHits += latencyMs >= 5_000 ? 1 : 0
            recordTimeline({
              ...current.correlation,
              event: 'media_timeline',
              stage: 'camera_renderer_fenced_after_loss',
              durationMs: latencyMs,
              anomaly: true,
              reason: 'camera-preview-renderer-loss',
            })
          }
          activeHandles.delete(handleKey)
          inFlight.delete(key)
        }
        allReferencesReleased()
      },
    })
  }

  const replaceCameraRenderer = async () => {
    if (cameraRendererLossCompleted) return
    cameraRendererLossCompleted = true
    cameraReplacementReady = false
    cameraPreviewRendererLosses += 1
    if (!cameraWindow.isDestroyed()) cameraWindow.destroy()
    cameraBridge?.rendererReloaded()
    cameraWindow = new electron.BrowserWindow(cameraWindowOptions)
    cameraWindowReady = cameraWindow.loadURL(contentionPageDataUrl())
    await cameraWindowReady
    cameraReplacementReady = true
    recordTimeline({
      event: 'media_timeline',
      stage: 'camera_renderer_replacement_ready',
      elapsedMs: Date.now() - startedAtMs,
    })
  }

  const sendCameraPreviewTexture = async (target, metadata) => {
    const frame = cameraPreviewFrames.get(
      Number(metadata.nativeCaptureTimestampUs),
    )
    if (!frame) throw new Error('camera preview metadata was not staged for send')
    await cameraWindowReady
    const key = cameraPreviewFrameKey(frame.runtimeEpoch, frame.sequence)
    const entry = inFlight.get(key)
    const injectRendererLoss = !cameraRendererLossScheduled &&
      contentionStartedAtMs !== null &&
      Date.now() - contentionStartedAtMs >=
        profile.faultSchedule.electronFenceDelay[0].atMs
    if (injectRendererLoss) {
      cameraRendererLossScheduled = true
      entry.injected = true
      const timer = setTimeout(() => {
        void replaceCameraRenderer().catch((error) => {
          fail(`camera renderer replacement: ${String(error)}`)
        })
      }, 5_500)
      timer.unref?.()
    }
    return electron.sharedTexture.sendSharedTexture(target, {
      ...metadata,
      kind: 'camera',
      width: frame.width,
      height: frame.height,
      nativeTimestampUs: frame.timestampUs,
      mainSentAtMs: Date.now(),
      holdMs: injectRendererLoss
        ? Math.max(profile.rendererFenceRecovery.retainedFenceMs, 6_000)
        : 0,
    })
  }

  const releaseCameraPreviewFrameOwned = async (frame) => {
    const startedAt = Date.now()
    try {
      await utilityRuntime.runRendererLeaseRelease(remoteSupervisor, {
        type: 'releaseLocalCameraPreviewFrame',
        sessionId: frame.sessionId,
        generation: frame.generation,
        trackId: frame.trackId,
        sequence: frame.sequence,
      })
      if (!isRetiredRendererRelease(frame.runtimeEpoch, remoteSupervisor.getSnapshot())) {
        cameraPreviewFenceAcks += 1
      }
      recordTimeline({
        ...frameCorrelation(frame),
        event: 'media_timeline',
        stage: 'camera_native_released',
        durationMs: Math.max(0, Date.now() - startedAt),
      })
    } catch (error) {
      if (!isRetiredRendererRelease(
        frame.runtimeEpoch,
        remoteSupervisor.getSnapshot(),
      )) {
        cameraPreviewReleaseFailures += 1
        fail(`camera preview native release: ${String(error)}`)
      }
    }
  }

  const releaseCameraPreviewFrame = (frame) => {
    const owned = trackPendingOperation(
      activeRendererLeaseReleases,
      releaseCameraPreviewFrameOwned(frame),
    )
    maximumMainPending = Math.max(
      maximumMainPending,
      inFlight.size + releaseRequests.size + activeRemoteDeliveries.size +
        activeRendererLeaseReleases.size,
    )
    return owned
  }

  const deliverCameraPreviewFrame = async (adapter, value) => {
    if (!cameraBridge) return
    if (classifyRuntimeFrameEpoch(
      adapter.hostEpoch,
      latestRuntimeEpoch,
    ) === 'pending' && adapter === currentProbeAdapter) {
      await waitUntil(
        () => adapter.hostEpoch === latestRuntimeEpoch ||
          adapter !== currentProbeAdapter,
        5_000,
      )
    }
    if (adapter !== currentProbeAdapter ||
        classifyRuntimeFrameEpoch(
          adapter.hostEpoch,
          latestRuntimeEpoch,
        ) !== 'current') return
    const ntHandle = Buffer.alloc(8)
    ntHandle.writeBigUInt64LE(BigInt(value.ntHandle))
    const frame = {
      sessionId: value.sessionId,
      generation: value.generation,
      trackId: value.trackId,
      participantIdentity: value.participantIdentity,
      source: value.source,
      local: true,
      sequence: value.sequence,
      width: value.width,
      height: value.height,
      timestampUs: value.timestampUs,
      sourceTimestampUs: Number(value.sourceTimestampUs) || 0,
      runtimeEpoch: adapter.hostEpoch,
      ntHandle,
      rawNtHandle: value.ntHandle,
      pipelineFrameId: '',
    }
    const key = cameraPreviewFrameKey(frame.runtimeEpoch, frame.sequence)
    inFlight.set(key, {
      correlation: frameCorrelation(frame),
      receivedAtMs: Date.now(),
      importedAtMs: Date.now(),
      handleKey: String(value.ntHandle),
      retainedBytes: frame.width * frame.height * 4,
      injected: false,
    })
    maximumMainPending = Math.max(maximumMainPending, inFlight.size)
    maximumRetainedBytes = Math.max(
      maximumRetainedBytes,
      [...inFlight.values()].reduce(
        (sum, retained) => sum + retained.retainedBytes,
        0,
      ),
    )
    cameraPreviewFrames.set(frame.timestampUs, frame)
    try {
      const delivered = await cameraBridge.deliver(frame)
      if (!delivered && !activeHandles.has(String(value.ntHandle))) {
        inFlight.delete(key)
      }
    } catch (error) {
      inFlight.delete(key)
      fail(`camera preview bridge delivery: ${String(error)}`)
    } finally {
      cameraPreviewFrames.delete(frame.timestampUs)
    }
  }

  remoteSupervisor = new utilityRuntime.NativeRuntimeSupervisor({
    runtime: 'media',
    createAdapter: createProbeAdapter,
    handshakeTimeoutMs: 5_000,
    probeTimeoutMs: 2_500,
    schedule: (callback, delayMs) => scheduleAfterProbeRetirement(
      callback,
      contentionProbeRestartDelayMs(delayMs, profile),
      probeRetirement,
    ),
  })
  remoteBridge = new utilityRuntime.NativeSharedTextureBridge({
    getWindow: () => window,
    release: releaseRemoteFrame,
    importTexture: importRemoteTexture,
    sendTexture: sendRemoteTexture,
    maxInFlight: 3,
    maxRetainedBytes: 256 * 1024 * 1024,
    stallTimeoutMs: profile.rendererFenceRecovery.reloadDeadlineMs,
    retiredFenceReloadMs: profile.rendererFenceRecovery.reloadDeadlineMs,
    retiredFenceRecycleMs: profile.rendererFenceRecovery.recycleDeadlineMs,
    onPresentationStalled: async (frame, reason, metrics) => {
      recordTimeline({
        ...frameCorrelation(frame),
        event: 'media_timeline',
        stage: 'renderer_recovery',
        anomaly: true,
        reason,
        metrics,
      })
      if (reason === 'retired-fence-deadline') {
        rendererReloadCount += 1
        remoteBridge.rendererReloaded()
      } else if (reason === 'retired-fence-recycle') {
        const recycled = remoteSupervisor.recycleRendererFenceOwner(
          frame.runtimeEpoch,
        )
        // Screen-backend churn can replace the fence-owner probe in the same
        // 6s CI window as the retired-fence reaper. Count that replacement
        // once; the reaper must not add a second recycle against a dead epoch.
        if (
          !rendererFenceRecycleCompleted &&
          (recycled || latestRuntimeEpoch > frame.runtimeEpoch)
        ) {
          rendererFenceHostRecycles += 1
          rendererFenceRecycleCompleted = true
        }
      }
    },
    onOperationFailed: (stage, frame, error) => {
      fail(`remote shared texture ${stage}: ${String(error)} ` +
        `(epoch ${frame.runtimeEpoch})`)
    },
  })
  cameraBridge = new utilityRuntime.NativeSharedTextureBridge({
    getWindow: () => cameraWindow,
    release: releaseCameraPreviewFrame,
    importTexture: importCameraPreviewTexture,
    sendTexture: sendCameraPreviewTexture,
    maxInFlight: 3,
    maxRetainedBytes: 256 * 1024 * 1024,
    stallTimeoutMs: profile.rendererFenceRecovery.retainedFenceMs + 2_000,
    retiredFenceReloadMs: profile.rendererFenceRecovery.retainedFenceMs + 2_000,
    retiredFenceRecycleMs: profile.rendererFenceRecovery.retainedFenceMs + 4_000,
    onPresentationStalled: async (frame, reason, metrics) => {
      recordTimeline({
        ...frameCorrelation(frame),
        event: 'media_timeline',
        stage: 'camera_renderer_recovery',
        anomaly: true,
        reason,
        metrics,
      })
    },
    onOperationFailed: (stage, frame, error) => {
      if (cameraRendererLossCompleted && stage === 'send') return
      fail(`camera shared texture ${stage}: ${String(error)} ` +
        `(epoch ${frame.runtimeEpoch})`)
    },
  })
  remoteSupervisor.onStateChange((snapshot) => {
    if (snapshot.status !== 'ready' || !snapshot.hostEpoch ||
      snapshot.hostEpoch <= latestRuntimeEpoch) return
    const previousEpoch = latestRuntimeEpoch
    latestRuntimeEpoch = snapshot.hostEpoch
    recordTimeline({
      event: 'media_timeline',
      stage: 'probe_replacement_ready',
      runtimeEpoch: snapshot.hostEpoch,
      elapsedMs: Date.now() - startedAtMs,
    })
    remoteBridge.runtimeReplaced(snapshot.hostEpoch)
    cameraBridge.runtimeReplaced(snapshot.hostEpoch)
    const assigned = assignContentionRecoveryEpochs(
      {
        fenceOwnerEpoch,
        voiceTimeoutEpoch,
        voiceTimeoutArmed,
        rendererFenceRecycleCompleted,
        rendererFenceHostRecycles,
        voiceTimeoutRecycleCompleted,
        voiceControlTimeoutRecycles,
      },
      previousEpoch,
      snapshot.hostEpoch,
    )
    fenceOwnerEpoch = assigned.fenceOwnerEpoch
    voiceTimeoutEpoch = assigned.voiceTimeoutEpoch
    rendererFenceRecycleCompleted = assigned.rendererFenceRecycleCompleted
    rendererFenceHostRecycles = assigned.rendererFenceHostRecycles
    voiceTimeoutRecycleCompleted = assigned.voiceTimeoutRecycleCompleted
    voiceControlTimeoutRecycles = assigned.voiceControlTimeoutRecycles
  })
  await remoteSupervisor.start()
  const linkedVideoDeadlineMs = linkedVideoReadyDeadlineMs(profile)
  await waitUntil(
    () => hasLinkedVideoPresentation(linkedVideoCandidates),
    linkedVideoDeadlineMs,
  )
  if (!hasLinkedVideoPresentation(linkedVideoCandidates)) {
    throw new Error(
      'linked Room video did not reach exact Electron presentation before contention',
    )
  }
  if (options.contentionStartedFile) {
    await mkdir(path.dirname(options.contentionStartedFile), { recursive: true })
    await writeFile(options.contentionStartedFile, `${Date.now()}\n`)
  }
  contentionStartedAtMs = Date.now()

  const durationSeconds = Math.ceil(profile.durationMs / 1_000)
  const targetCaptureFrames = durationSeconds * 60
  captureChild = spawnOwned(
    'screen-capture',
    executables.streaming,
    [
      '1920',
      '1080',
      '1280',
      '720',
      String(targetCaptureFrames),
      '--capture-soak',
      'screen:1',
      String(process.pid),
      String(durationSeconds),
      String(profile.screenBackendChurnIntervalMs),
    ],
    (line) => {
      const match = line.match(
        /^EXTERNAL_PREVIEW nt_handle=(\d+) sequence=(\d+) timestamp_us=(\d+) width=(\d+) height=(\d+)/,
      )
      if (match) {
        void deliverTexture('local', captureChild, {
          ntHandle: match[1],
          sequence: Number(match[2]),
          timestampUs: Number(match[3]),
          width: Number(match[4]),
          height: Number(match[5]),
        })
        return
      }
      const ack = line.match(/^RELEASE_ACK sequence=(\d+)/)
      if (ack) completeRelease(`local:${Number(ack[1])}`)
      const parsed = parsePrefixedJson(line)
      if (parsed?.prefix === 'CONTENTION_CAPTURE_SUMMARY') {
        captureSummary = parsed.value
      }
    },
    {
      ...mediaPriorityPolicyEnvironment(options.priorityPolicy),
      SYRNIKE_NATIVE_DIAGNOSTIC_RUN_ID: diagnosticRunId,
      SYRNIKE_NATIVE_MEDIA_LOG_PATH: captureDiagnosticPath,
    },
  )

  spawnOwned(
    'competing-load',
    executables.streaming,
    [
      '1920',
      '1080',
      '1280',
      '720',
      '1',
      '--competing-load',
      String(profile.durationMs),
    ],
    (line) => {
      const parsed = parsePrefixedJson(line)
      if (parsed?.prefix === 'CONTENTION_COMPETITOR_SUMMARY') {
        competitorSummary = parsed.value
      }
    },
  )

  spawnOwned(
    'h264-encoder',
    executables.streaming,
    [
      '1920',
      '1080',
      '1280',
      '720',
      '1',
      '--h264-soak',
      String(profile.durationMs),
    ],
    (line) => {
      if (/^ASSERT hardware_encode codec=H264 .*clean_shutdown=pass/.test(line)) {
        hardwareH264Observed = true
        evidence.environment.capabilities.hardwareH264 = { available: true }
      } else if (/^SKIP hardware_encode codec=H264/.test(line)) {
        evidence.environment.capabilities.hardwareH264 = {
          available: false,
          reason: line.slice(0, 512),
        }
      }
    },
  )

  let expectedMainTick = performance.now() + 10
  const mainLoopTimer = setInterval(() => {
    const now = performance.now()
    const delayMs = Math.max(0, now - expectedMainTick)
    expectedMainTick = now + 10
    if (Date.now() - startedAtMs < profile.measurementWarmupMs) return
    mainLoopMaximumMs = Math.max(mainLoopMaximumMs, delayMs)
    mainLoopSamples.add(delayMs)
  }, 10)

  await delay(profile.durationMs)
  faultInjectionClosed = true
  let completionBlockers = []
  const completionReady = () => {
    const lifecycle = lifecycleStatusByEpoch.get(latestRuntimeEpoch) ?? {}
    completionBlockers = contentionCompletionBlockers({
      voiceTimeoutRecycleCompleted,
      demandRemovalCompleted,
      pendingStartup: lifecycle.pendingStartup,
      pendingMainOperations:
        inFlight.size + releaseRequests.size + activeRemoteDeliveries.size +
        activeRendererLeaseReleases.size +
        (Number(lifecycle.pendingReleaseOperations) || 0),
      remoteRendererLeases: lifecycle.rendererLeases,
      remoteGpuGenerations: lifecycle.remoteGpuGenerations,
      resourceBaselineCaptured:
        resourceBaselineEpochs.has(latestRuntimeEpoch),
    })
    return completionBlockers.length === 0
  }
  await waitUntil(completionReady, completionDeadlineMs)
  if (!completionReady()) {
    fail(
      'contention completion deadline retained: ' +
      completionBlockers.join(', '),
    )
  }
  await waitUntil(() => activeRemoteDeliveries.size === 0, 2_000)
  if (activeRemoteDeliveries.size !== 0) {
    fail('video delivery operations did not drain before bridge disposal')
  }
  remoteBridge.dispose()
  cameraBridge.dispose()
  await waitUntil(
    () => remoteBridge.inFlightCount === 0 && cameraBridge.inFlightCount === 0 &&
      activeRendererLeaseReleases.size === 0,
    2_000,
  )
  if (activeRendererLeaseReleases.size !== 0) {
    fail('renderer lease release operations did not drain before native shutdown')
  }
  finalElectronInFlightTextures =
    remoteBridge.inFlightCount + cameraBridge.inFlightCount
  finalElectronRetainedTextureBytes =
    remoteBridge.retainedByteCount + cameraBridge.retainedByteCount
  try {
    await remoteSupervisor.shutdown()
  } catch (error) {
    fail(`remote supervisor shutdown: ${String(error)}`)
  }
  if (probeChild?.ownedExit) {
    let exitedGracefully = false
    await Promise.race([
      probeChild.ownedExit.then(() => { exitedGracefully = true }),
      delay(8_500),
    ])
    if (!exitedGracefully) {
      fail('final native probe did not exit after bounded graceful shutdown')
      probeChild.kill()
    }
  }
  for (const exit of deferredUnexpectedExits) {
    fail(`${exit.name} exited with ${String(exit.code)}`)
  }
  if (localLiveKitServer.exitCode === null &&
      localLiveKitServer.signalCode === null) {
    localLiveKitServer.kill()
  }
  await Promise.race([
    Promise.all(childExits),
    delay(20_000),
  ])
  clearInterval(mainLoopTimer)
  clearInterval(windowMotionTimer)
  const teardown = await shutdownChildren(children, {
    deadlineMs: 2_000,
    forceAfterMs: 500,
  })
  if (teardown.orphanPids.length > 0) {
    fail(`owned child teardown deadline exceeded: ${teardown.orphanPids.join(',')}`)
  }
  await delay(50)

  const elapsedMs = Date.now() - startedAtMs
  const native = nativeSummary ?? {}
  const capture = captureSummary ?? {}
  const competitor = competitorSummary ?? {}
  const diagnosticRecords = await readDiagnosticRecords([
    captureDiagnosticPath,
    ...probeDiagnosticPaths,
  ])
  evidence.priorityOutcome = extractPriorityOutcome(
    diagnosticRecords,
    options.priorityPolicy,
  )
  evidence.priorityDiagnostics = {
    policy: options.priorityPolicy,
    remoteAudioMmcss: diagnosticRecords
      .filter((record) => record?.event === 'remote_audio_renderer_mmcss')
      .at(-1) ?? null,
  }
  const mainP95Ms = percentile(mainLoopSamples.values(), 0.95)
  const mainP99Ms = percentile(mainLoopSamples.values(), 0.99)
  const nativeMaximum = (name, fallback = 0) => Math.max(
    fallback,
    ...nativeSummaries.map((summary) => Number(summary[name]) || 0),
  )
  const resourceBaselineSummaries =
    selectResourceBaselineSummaries(nativeSummaries)
  const resourceMaximum = (name, fallback = 0) => Math.max(
    fallback,
    ...resourceBaselineSummaries.map(
      (summary) => Number(summary[name]) || 0,
    ),
  )
  const latestAudioEvidence = selectLatestAudioEvidence(audioEvidenceRecords)
  const audioMaximum = (name, fallback = 0) => Math.max(
    fallback,
    ...latestAudioEvidence.map((record) => Number(record[name]) || 0),
  )
  evidence.faultHits = {
    gpuCompletionDelay: Math.max(
      aggregateGpuFaultHits,
      Number(native.gpuFaultHits) || 0,
    ),
    electronFenceDelay: injectedFenceHits,
    liveKitCallbackHold: Math.max(
      aggregateLiveKitFaultHits,
      Number(native.liveKitFaultHits) || 0,
    ),
    audioSchedulingGap: Math.max(
      aggregateAudioGapHits,
      Number(native.audioGapHits) || 0,
    ),
  }
  const videoStreamGenerationsByEpoch = new Map(nativeSummaries.map((summary) => [
    summary.hostEpoch,
    Number(summary.videoStreamGenerations) || 0,
  ]))
  const nativeVideoQueueEvidence = summarizeNativeVideoQueue(
    nativeProbeStderr,
    { deliveredFrames: remoteHandleImports, videoStreamGenerationsByEpoch },
  )
  evidence.metrics = {
    elapsedMs,
    uiEventLoopP95Ms: Math.max(mainP95Ms, rendererLoopP95Ms),
    uiEventLoopP99Ms: Math.max(mainP99Ms, rendererLoopP99Ms),
    uiEventLoopMaxMs: Math.max(mainLoopMaximumMs, rendererLoopMaximumMs),
    ...buildDistributionMetrics(
      normalVideoFrameAgeSamples.values(),
      latestAudioEvidence,
    ),
    normalVideoFrameAgeMaxMs,
    localPlayoutScheduledAgeMaxMs:
      audioMaximum('normalAudioAgeMaxUs') / 1_000,
    postRecoveryPlayoutAgeMaxMs:
      Math.max(
        aggregatePostRecoveryAudioAgeUs,
        audioMaximum('postRecoveryAudioAgeMaxUs'),
      ) / 1_000,
    injectedAudioScheduledAgeMaxMs:
      Math.max(
        aggregateInjectedAudioAgeUs,
        audioMaximum('injectedAudioScheduledAgeMaxUs'),
      ) / 1_000,
    releaseRequestLatencyMaxMs,
    injectedReleaseRecoveryDurationMaxMs,
    injectedReleaseRetirementRecoveries,
    uncorrelatedReleaseRetirements,
    injectedRendererFenceLatencyMaxMs,
    screenCaptureFrames: Number(capture.frames) || 0,
    screenCadenceFps: Number(capture.cadenceFps) || 0,
    screenOrdinaryCadenceFps:
      Number(capture.ordinaryCadenceFps) || 0,
    screenCadenceGapMaxMs: Number(capture.cadenceGapMaxMs) || 0,
    screenBackendChurnCount: Number(capture.backendChurnCount) || 0,
    screenBackendChurnRecoveryMaxMs:
      Number(capture.backendChurnDurationMaxMs) || 0,
    screenRecoverableTransitions:
      Number(capture.recoverableTransitions) || 0,
    screenGpuSlotTimeouts: Number(capture.gpuSlotTimeouts) || 0,
    screenGpuPoolRollovers: Number(capture.gpuPoolRollovers) || 0,
    screenCaptureResetCount: Number(capture.captureResetCount) || 0,
    screenResourceBaselineCaptured:
      Number(capture.resourceBaselineCaptured) || 0,
    screenThreadDeltaMax: Number(capture.threadDeltaMax) || 0,
    screenHandleDeltaMax: Number(capture.handleDeltaMax) || 0,
    screenHandleTypes:
      Array.isArray(capture.handleTypes) ? capture.handleTypes : [],
    competingWorkloadFps: Number(competitor.cadenceFps) || 0,
    competingWorkloadP95Ms: Number(competitor.cadenceP95Ms) || 0,
    competingWorkloadP99Ms: Number(competitor.cadenceP99Ms) || 0,
    competingWorkloadGpuSubmissions:
      Number(competitor.gpuSubmissions) || 0,
    competingWorkloadCpuIterations:
      Number(competitor.cpuIterations) || 0,
    threadDeltaMax: resourceMaximum('threadDeltaMax'),
    threadDeltaFinal: resourceMaximum('threadDeltaFinal'),
    resourceBaselineCaptured:
      resourceBaselinesComplete(nativeSummaries) ? 1 : 0,
    handleDeltaMax: resourceMaximum('handleDeltaMax'),
    pendingOperationsMax: Math.max(
      maximumMainPending,
      nativeMaximum('pendingOperationsMax'),
    ),
    finalPendingOperations:
      inFlight.size + releaseRequests.size + activeRemoteDeliveries.size +
      activeRendererLeaseReleases.size +
      (Number(native.finalPendingOperations) || 0),
    maximumActiveGenerations: Math.max(
      1,
      nativeMaximum('maximumActiveGenerations'),
      maximumRemoteGpuGenerations,
    ),
    maximumQuarantinedGenerations:
      Math.max(
        nativeMaximum('maximumQuarantinedGenerations'),
        maximumRemoteGpuGenerations > 0 ? maximumRemoteGpuGenerations - 1 : 0,
      ),
    maximumActiveBackends: Math.max(
      1,
      nativeMaximum('maximumActiveBackends'),
    ),
    maximumQuarantinedBackends:
      nativeMaximum('maximumQuarantinedBackends'),
    approximateGpuBytesMax:
      Math.max(
        configuredRemoteGpuBytesMax,
        nativeMaximum('approximateGpuBytesMax'),
      ),
    prematureTextureReuse:
      prematureTextureReuse + (Number(native.prematureTextureReuse) || 0),
    resetCount: nativeMaximum('resetCount'),
    republishCount: nativeMaximum('republishCount'),
    finalHeldLeases:
      inFlight.size + (Number(native.finalHeldLeases) || 0),
    rendererFenceBlockedTransitions,
    gpuFaultArmedAfterHeld,
    rolloverWhileHeldProofs,
    gpuFaultForcedTimeouts,
    rendererBlockedTimedWakeups,
    remoteVideoPoolRollovers,
    configuredRemoteFourKPoolBytes,
    configuredRemoteGpuBytesMax,
    maximumRemoteGpuGenerations,
    maximumRemoteRendererLeases,
    maximumRemoteRendererGenerations,
    videoStreamGenerationsMax: nativeMaximum('videoStreamGenerations'),
    decodedVideoQueueEvidenceComplete:
      nativeVideoQueueEvidence.complete ? 1 : 0,
    decodedVideoQueueDroppedFrames:
      nativeVideoQueueEvidence.droppedFrames,
    decodedVideoQueueStreamsWithDrops:
      nativeVideoQueueEvidence.streamsWithDrops,
    decodedVideoQueueMaximumDroppedFrames:
      nativeVideoQueueEvidence.maximumDroppedFrames,
    decodedVideoQueueDropRatio: nativeVideoQueueEvidence.dropRatio,
    remoteHandleImports,
    remoteFenceAcks,
    remoteFenceReleaseFailures,
    cameraPreviewHandleImports,
    cameraPreviewDelayedFenceHits,
    cameraPreviewRendererLosses,
    cameraPreviewFreshFramesAfterLoss,
    cameraPreviewFenceAcks,
    cameraPreviewReleaseFailures,
    finalCameraPreviewFrames,
    finalCameraPreviewUsageBytes,
    finalCameraPreviewUsageGenerations,
    freshFramesAfterRecovery,
    rendererReloadCount,
    rendererFenceHostRecycles,
    voiceControlTimeoutRecycles,
    demandRemovals,
    finalRemoteRendererLeases,
    finalRemoteUsageBytes,
    finalRemoteUsageGenerations,
    finalElectronInFlightTextures,
    finalElectronRetainedTextureBytes,
    audioRecoverySamples: audioRecoverySamples.filter(Boolean),
    audioRecoverySettled:
      audioRecoverySettledIndexes.size === audioRecoverySamples.length ? 1 : 0,
    audioRecoveryArmed: audioRecoveryArmed ? 1 : 0,
    remoteAudioPlayout: buildRemoteAudioPlayoutMetrics(latestAudioEvidence),
    linkedVideoPipeline: [...linkedVideoCandidates.values()].find(
      (candidate) => hasLinkedVideoPresentation(
        new Map([['candidate', candidate]]),
      ),
    ) ?? null,
  }
  const rejectedNativeStderr = classifyNativeProbeStderr(nativeProbeStderr, {
    linkedVideoPresented: Boolean(evidence.metrics.linkedVideoPipeline),
    freshFramesAfterRecovery: evidence.metrics.freshFramesAfterRecovery,
    liveKitCallbackHoldHits: evidence.faultHits.liveKitCallbackHold,
    videoStreamGenerationsByEpoch,
    nativeVideoQueueEvidence,
    linkedVideoPresentationEpochs,
  })
  for (const record of rejectedNativeStderr) {
    fail(`native-probe-epoch-${record.hostEpoch} stderr: ${record.line}`)
  }
  if (!hardwareH264Observed &&
      evidence.environment.capabilities.hardwareH264.available !== false) {
    evidence.environment.capabilities.hardwareH264 = {
      available: false,
      reason: 'H.264 hardware encoder completion was not observed',
    }
  }
  const artifact = buildContentionArtifact(evidence)
  const artifactPath = await writeRotatedArtifact(
    outputDirectory,
    profile.name,
    artifact,
  )
  if (process.env.SYRNIKE_KEEP_MEDIA_DIAGNOSTICS !== '1') {
    await rm(diagnosticDirectory, { recursive: true, force: true })
  }
  console.log(JSON.stringify({
    status: artifact.result.status,
    artifactPath,
    blockers: artifact.result.blockers,
    failures: artifact.result.failures,
  }))
  if (!cameraWindow.isDestroyed()) cameraWindow.destroy()
  window.destroy()
  electron.app.exit(
    artifact.result.status === 'pass'
      ? 0
      : artifact.result.status === 'blocked'
        ? 2
        : 1,
  )
  return { artifact, artifactPath }
}

function createEvidence(profile) {
  const unavailable = (reason) => ({ available: false, reason })
  return {
    profile,
    environment: {
      platform: process.platform,
      source: readSourceProvenance(),
      capabilities: {
        screenCapture: unavailable('real screen capture was not presented'),
        hardwareH264: unavailable('hardware H.264 was not completed'),
        electronSharedTexture: unavailable('Electron shared texture was not imported'),
        remoteViewer: unavailable('remote shared texture was not presented'),
        cameraPreview: unavailable(
          'camera preview shared texture was not presented cross-process',
        ),
        audioOutput: unavailable('Windows audio output was not started'),
        audioPolicyMatrix: unavailable(
          'no --audio-policy-result hook evidence was provided',
        ),
      },
    },
    operationalFailures: [],
    faultHits: {},
    metrics: {},
    timeline: [],
  }
}

function releaseNativeWithoutImport(kind, child, frame, requestId) {
  if (!child?.stdin?.writable) return
  const command = kind === 'remote'
    ? `RELEASE_REMOTE ${frame.sequence} ${requestId}`
    : `RELEASE ${frame.sequence}`
  child.stdin.write(`${command}\n`)
}

function attachLineReader(stream, onLine, onError) {
  let pending = ''
  stream.setEncoding('utf8')
  stream.on('data', (chunk) => {
    pending += chunk
    if (pending.length > 64 * 1024 && !pending.includes('\n')) {
      onError('one output line exceeded 64 KiB')
      pending = ''
      return
    }
    for (;;) {
      const newline = pending.indexOf('\n')
      if (newline < 0) break
      const line = pending.slice(0, newline).replace(/\r$/, '')
      pending = pending.slice(newline + 1)
      onLine(line)
    }
  })
}

function parsePrefixedJson(line) {
  const separator = line.indexOf(' ')
  if (separator <= 0) return null
  const prefix = line.slice(0, separator)
  if (![
    'CAPABILITY',
    'RUNTIME_READY',
    'FAULT',
    'VIDEO_HANDOFF',
    'LIVEKIT_PIPELINE',
    'AUDIO_PLAYOUT',
    'AUDIO_PIPELINE',
    'REMOTE_FRAME',
    'CAMERA_FRAME',
    'RELEASE_ACK',
    'CAMERA_RELEASE_ACK',
    'DEMAND_REMOVED',
    'FINISH_ACK',
    'GPU_FAULT_ARMED',
    'AUDIO_RECOVERY_ARMED',
    'ROLLOVER_WHILE_HELD',
    'BRIDGE_STATUS',
    'RESOURCE_BASELINE_SAMPLE',
    'LIFECYCLE_STATUS',
    'PUBLICATION_TEARDOWN',
    'PUBLICATION_LIFECYCLE',
    'RESOURCE_ATTRIBUTION',
    'TIMELINE',
    'SUMMARY',
    'CONTENTION_CAPTURE_SUMMARY',
    'CONTENTION_COMPETITOR_SUMMARY',
  ].includes(prefix)) {
    return null
  }
  try {
    return { prefix, value: JSON.parse(line.slice(separator + 1)) }
  } catch {
    return null
  }
}

async function readDiagnosticRecords(paths) {
  const records = []
  for (const diagnosticPath of paths) {
    let contents
    try {
      contents = await readFile(diagnosticPath, 'utf8')
    } catch (error) {
      if (error?.code === 'ENOENT') continue
      throw error
    }
    for (const line of contents.split(/\r?\n/)) {
      if (!line.trim()) continue
      try {
        records.push(JSON.parse(line))
      } catch {
        // A truncated final diagnostic line is excluded from policy evidence.
      }
    }
  }
  return records
}

function mediaPriorityPolicyEnvironment(priorityPolicy) {
  return { SYRNIKE_MEDIA_PRIORITY_POLICY: priorityPolicy }
}

function parseRunnerOptions(argv) {
  const result = { profile: 'ci', priorityPolicy: 'normal' }
  for (let index = 0; index < argv.length; index += 1) {
    const option = argv[index]
    const value = argv[++index]
    if (value === undefined) throw new Error(`missing value for ${option}`)
    if (option === '--profile') result.profile = value
    else if (option === '--duration-ms') result.durationMs = Number(value)
    else if (option === '--build-dir') result.buildDirectory = value
    else if (option === '--output-dir') result.outputDirectory = value
    else if (option === '--audio-policy-result') result.audioPolicyResult = value
    else if (option === '--livekit-server') result.liveKitServer = value
    else if (option === '--livekit-room') result.liveKitRoom = value
    else if (option === '--livekit-participants-file') {
      result.liveKitParticipantsFile = value
    }
    else if (option === '--contention-started-file') {
      result.contentionStartedFile = value
    }
    else if (option === '--priority-policy') {
      if (!['normal', 'capture', 'legacy-high'].includes(value)) {
        throw new Error(`unknown media priority policy: ${value}`)
      }
      result.priorityPolicy = value
    }
    else if (option === '--probe-camera-preview-enabled') {
      if (!['0', '1'].includes(value)) {
        throw new Error('--probe-camera-preview-enabled must be 0 or 1')
      }
      result.probeCameraPreviewEnabled = value === '1'
    }
    else throw new Error(`unknown media contention option: ${option}`)
  }
  return result
}

function percentile(values, quantile) {
  if (values.length === 0) return 0
  const sorted = [...values].sort((left, right) => left - right)
  return sorted[Math.min(
    sorted.length - 1,
    Math.floor((sorted.length - 1) * quantile),
  )]
}

function selectLatestAudioEvidence(records) {
  const latestByEpoch = new Map()
  for (const record of records) {
    const hostEpoch = Number(record?.hostEpoch)
    const evidenceSequence = Number(record?.evidenceSequence)
    if (!Number.isSafeInteger(hostEpoch) || hostEpoch <= 0 ||
        !Number.isSafeInteger(evidenceSequence) || evidenceSequence <= 0) {
      continue
    }
    const previous = latestByEpoch.get(hostEpoch)
    if (!previous || evidenceSequence > previous.evidenceSequence) {
      latestByEpoch.set(hostEpoch, record)
    }
  }
  return [...latestByEpoch.values()].sort(
    (left, right) => left.hostEpoch - right.hostEpoch,
  )
}

function buildDistributionMetrics(videoFrameAgeSamples, nativeSummaries) {
  const sampledAudioSummaries = nativeSummaries.filter(
    (summary) => Number(summary?.normalAudioAgeSampleCount) > 0,
  )
  const maximumSummaryMetric = (name) => {
    const values = sampledAudioSummaries
      .map((summary) => Number(summary?.[name]))
      .filter(Number.isFinite)
    return values.length > 0 ? Math.max(...values) / 1_000 : Number.NaN
  }
  return {
    normalVideoFrameAgeP95Ms: videoFrameAgeSamples.length > 0
      ? percentile(videoFrameAgeSamples, 0.95)
      : Number.NaN,
    normalVideoFrameAgeP99Ms: videoFrameAgeSamples.length > 0
      ? percentile(videoFrameAgeSamples, 0.99)
      : Number.NaN,
    localPlayoutScheduledAgeSampleCount: sampledAudioSummaries.reduce(
      (total, summary) => total + Number(summary.normalAudioAgeSampleCount),
      0,
    ),
    localPlayoutScheduledAgeP95Ms:
      maximumSummaryMetric('normalAudioAgeP95Us'),
    localPlayoutScheduledAgeP99Ms:
      maximumSummaryMetric('normalAudioAgeP99Us'),
  }
}

function buildRemoteAudioPlayoutMetrics(nativeSummaries) {
  const compatible = nativeSummaries.length > 0 && nativeSummaries.every(
    (summary) => summary?.protocolVersion === 1,
  )
  const trackIds = new Set(nativeSummaries.map(
    (summary) => String(summary?.audioTrackId || ''),
  ))
  const trackId = compatible && trackIds.size === 1
    ? [...trackIds][0]
    : ''
  const sum = (name) => nativeSummaries.reduce(
    (total, summary) => total + (Number(summary?.[name]) || 0),
    0,
  )
  const linked = nativeSummaries.length > 0 && nativeSummaries.every(
    (summary) =>
      typeof summary?.publisherIdentity === 'string' &&
      summary.publisherIdentity.length > 0 &&
      typeof summary?.viewerIdentity === 'string' &&
      summary.viewerIdentity.length > 0 &&
      summary.publisherIdentity !== summary.viewerIdentity &&
      typeof summary?.publicationSid === 'string' &&
      summary.publicationSid.length > 0 &&
      summary.publicationSid === summary.remoteTrackSid,
  )
  return {
    protocolVersion: compatible ? 1 : 0,
    trackId,
    ingressFrames: sum('audioIngressFrames'),
    rendererFillCallbacks: sum('audioRendererFillCallbacks'),
    renderedSamples: sum('audioRenderedTrackFrames') * 2,
    injectedWakeGaps: sum('audioInjectedWakeGaps'),
    recoveredWakeGaps: sum('audioRecoveredWakeGaps'),
    trackFailures: sum('audioTrackFailures'),
    linkedRoomEpochs: linked ? nativeSummaries.length : 0,
  }
}

async function writeRotatedArtifact(directory, profile, artifact) {
  await mkdir(directory, { recursive: true })
  const prefix = `media-contention-${profile}-`
  const name = `${prefix}${new Date().toISOString().replace(/[:.]/g, '-')}.json.gz`
  const artifactPath = path.join(directory, name)
  await writeFile(artifactPath, gzipSync(JSON.stringify(artifact)))
  const candidates = (await readdir(directory))
    .filter((entry) => entry.startsWith(prefix) && entry.endsWith('.json.gz'))
  const dated = await Promise.all(candidates.map(async (entry) => ({
    entry,
    modifiedAt: (await stat(path.join(directory, entry))).mtimeMs,
  })))
  dated.sort((left, right) => right.modifiedAt - left.modifiedAt)
  for (const stale of dated.slice(3)) {
    await unlink(path.join(directory, stale.entry))
  }
  return artifactPath
}

function delay(durationMs) {
  return new Promise((resolve) => setTimeout(resolve, durationMs))
}

function shouldInjectRemoteRendererFence(
  heldRemoteFrames,
  rolloverWhileHeldProofs,
) {
  if (heldRemoteFrames >= 3) return false
  // Keep one of the three renderer delivery slots free while the native GPU
  // completion fault quarantines the five-slot upload pool. Two retained
  // leases preserve the cross-generation proof without starving submissions
  // before capacity exhaustion can be observed.
  return heldRemoteFrames < 2 || rolloverWhileHeldProofs > 0
}

if (process.versions.electron) {
  const electron = require('electron')
  runElectronContention(electron).catch(async (error) => {
    console.error(error instanceof Error ? error.stack : error)
    const teardown = await shutdownChildren([...activeRunnerChildren], {
      deadlineMs: 2_000,
      forceAfterMs: 500,
    })
    if (teardown.orphanPids.length > 0) {
      console.error(
        `owned child teardown deadline exceeded: ${teardown.orphanPids.join(',')}`,
      )
    }
    electron.app.exit(1)
  })
}

module.exports = {
  BoundedSampleWindow,
  buildContentionWindowOptions,
  buildLocalLiveKitServerArguments,
  canonicalizeAudioPipeline,
  canonicalizeVideoPipeline,
  classifyNativeProbeStderr,
  classifyRuntimeFrameEpoch,
  contentionCompletionBlockers,
  contentionCompletionDeadlineMs,
  contentionProbeDurationMs,
  isRetiredRendererRelease,
  isBridgeSkippedRetiredRelease,
  isCorrelatedInjectedRetirement,
  assignContentionRecoveryEpochs,
  contentionObservationElapsedMs,
  trackPendingOperation,
  buildDistributionMetrics,
  buildRemoteAudioPlayoutMetrics,
  contentionPageDataUrl,
  hasLinkedVideoPresentation,
  startContentionWindowMotion,
  mediaPriorityPolicyEnvironment,
  parseRunnerOptions,
  parsePrefixedJson,
  parseLiveKitJoinToken,
  runElectronContention,
  selectLatestAudioEvidence,
  selectResourceBaselineSummaries,
  resourceBaselinesComplete,
  shutdownChildren,
  summarizeNativeVideoQueue,
  shouldInjectRemoteRendererFence,
  shouldAwaitResourceBaseline,
}
