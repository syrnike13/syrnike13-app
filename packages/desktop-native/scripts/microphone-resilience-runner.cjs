const { execFileSync } = require('node:child_process')
const {
  appendFileSync,
  existsSync,
  mkdirSync,
  writeFileSync,
} = require('node:fs')
const path = require('node:path')
const { performance } = require('node:perf_hooks')

const WAIT_MS = 15_000
const PRODUCTION_FRAMES_PER_HOST = 90_000
const CI_FRAMES_PER_HOST = 30
const MAX_ACTIVE_UTILITY_HANDLES = 640

function parseOptions(argv) {
  const options = { profile: 'ci' }
  for (let index = 0; index < argv.length; ++index) {
    const value = argv[index]
    if (value === '--profile') options.profile = argv[++index]
    else if (value === '--addon') options.addon = argv[++index]
    else if (value === '--artifact') options.artifact = argv[++index]
    else throw new Error(`Unknown microphone soak option: ${value}`)
  }
  if (options.profile !== 'ci' && options.profile !== 'production') {
    throw new Error('Microphone soak profile must be ci or production')
  }
  return options
}

function withTimeout(promise, message, timeoutMs = WAIT_MS) {
  let timer
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(message)), timeoutMs)
    }),
  ]).finally(() => clearTimeout(timer))
}

function isMessage(value, predicate) {
  return typeof value === 'object' && value !== null && predicate(value)
}

function createUtilityHost(utilityProcess, hostPath, addonPath, label, log) {
  const messages = []
  const waiters = new Set()
  let exited = false
  const commitSha = execFileSync('git', ['rev-parse', 'HEAD'], {
    cwd: path.resolve(__dirname, '..', '..', '..'),
    encoding: 'utf8',
  }).trim()
  const diagnosticRunId = `microphone-resilience-${label}-${Date.now()}`
  const diagnosticPath = path.join(
    path.dirname(addonPath), `${diagnosticRunId}.jsonl`,
  )
  const child = utilityProcess.fork(hostPath, [], {
    serviceName: `syrnike-microphone-resilience-${label}`,
    stdio: 'pipe',
    env: {
      ...process.env,
      SYRNIKE_NATIVE_MODULE_PATH: addonPath,
      SYRNIKE_NATIVE_ROOT: path.dirname(addonPath),
      SYRNIKE_NATIVE_APP_VERSION: '0.6.11',
      SYRNIKE_NATIVE_RELEASE_CHANNEL: 'stable',
      SYRNIKE_NATIVE_CONTRACT_VERSION: '10',
      SYRNIKE_NATIVE_LIVEKIT_VERSION: '1.3.0',
      SYRNIKE_NATIVE_COMMIT_SHA: commitSha,
      SYRNIKE_NATIVE_DIAGNOSTIC_RUN_ID: diagnosticRunId,
      SYRNIKE_NATIVE_UTILITY_LOG_PATH: diagnosticPath,
    },
  })
  child.once('spawn', () => log(`utility_fork label=${label} pid=${child.pid}`))
  child.stdout?.on('data', (chunk) => log(`utility_stdout ${String(chunk).trimEnd()}`))
  child.stderr?.on('data', (chunk) => log(`utility_stderr ${String(chunk).trimEnd()}`))
  child.on('message', (message) => {
    messages.push(message)
    if (
      isMessage(message, (candidate) =>
        candidate.type === 'ready' || candidate.type === 'runtimeError',
      )
    ) {
      log(`utility_message label=${label} ${JSON.stringify(message)}`)
    }
    for (const waiter of [...waiters]) waiter(message)
  })
  const exit = new Promise((resolve, reject) => {
    child.once('error', reject)
    child.once('exit', (code) => {
      exited = true
      resolve(code)
    })
  })

  function waitForMessage(predicate, description, timeoutMs = WAIT_MS) {
    const existing = messages.find(predicate)
    if (existing) return Promise.resolve(existing)
    let waiter
    const pending = new Promise((resolve) => {
      waiter = (message) => {
        if (!predicate(message)) return
        waiters.delete(waiter)
        resolve(message)
      }
      waiters.add(waiter)
    })
    return withTimeout(pending, `Timed out waiting for ${label} ${description}`, timeoutMs)
      .finally(() => waiters.delete(waiter))
  }

  return {
    child,
    exit,
    waitForMessage,
    post(message) {
      child.postMessage(message)
    },
    killIfRunning() {
      if (!exited) child.kill()
    },
  }
}

function requestEnvelope(requestId, hostEpoch, command) {
  return {
    type: 'request',
    requestId,
    lane: command.type === 'shutdown' ? 'runtime' : 'microphone',
    hostEpoch,
    command,
    diagnostic: {
      actionId: `microphone-resilience-${requestId}`,
      operationId: `host-epoch-${hostEpoch}`,
      revision: hostEpoch,
      hostEpoch,
    },
  }
}

async function sendRequest(host, request) {
  const reply = host.waitForMessage(
    (message) => isMessage(
      message,
      (candidate) =>
        candidate.type === 'reply' && candidate.requestId === request.requestId,
    ),
    `reply ${request.requestId}`,
  )
  host.post(request)
  return reply
}

async function requireAccepted(host, request) {
  const reply = await sendRequest(host, request)
  if (!isMessage(reply, (candidate) => candidate.ok === true)) {
    throw new Error(`Utility request failed: ${request.requestId}`)
  }
  return reply
}

let nextControlId = 0
async function control(host, action, fields = {}) {
  const requestId = `resilience-control-${++nextControlId}`
  const reply = host.waitForMessage(
    (message) => isMessage(
      message,
      (candidate) =>
        candidate.type === 'microphoneResilienceControlReply' &&
        candidate.requestId === requestId,
    ),
    `control reply ${requestId}`,
  )
  host.post({
    type: 'microphoneResilienceControl',
    requestId,
    action,
    ...fields,
  })
  const result = await reply
  if (!isMessage(result, (candidate) => candidate.ok === true)) {
    throw new Error(`Utility resilience control failed: ${String(result.error)}`)
  }
  return result
}

async function snapshot(host) {
  const reply = await control(host, 'snapshot')
  if (!isMessage(reply.snapshot, () => true)) {
    throw new Error('Utility resilience snapshot is missing')
  }
  return reply.snapshot
}

async function runSegment(host, frames, realtime) {
  const requestId = `segment-${++nextControlId}`
  const accepted = host.waitForMessage(
    (message) => isMessage(
      message,
      (candidate) =>
        candidate.type === 'microphoneResilienceControlReply' &&
        candidate.requestId === requestId,
    ),
    `segment acceptance ${requestId}`,
  )
  const completed = host.waitForMessage(
    (message) => isMessage(
      message,
      (candidate) =>
        (candidate.type === 'microphoneResilienceSegmentComplete' ||
          candidate.type === 'microphoneResilienceSegmentFailed') &&
        candidate.requestId === requestId,
    ),
    `segment completion ${requestId}`,
    realtime ? frames * 10 + 30_000 : WAIT_MS,
  )
  host.post({
    type: 'microphoneResilienceControl',
    requestId,
    action: 'startSegment',
    frames,
    realtime,
  })
  const acceptance = await accepted
  if (!isMessage(acceptance, (candidate) => candidate.ok === true)) {
    throw new Error(`Utility rejected resilience segment ${requestId}`)
  }
  const result = await completed
  if (result.type !== 'microphoneResilienceSegmentComplete') {
    throw new Error(`Utility resilience segment failed: ${String(result.error)}`)
  }
  if (result.frames !== frames || result.maximumLagMilliseconds > 250) {
    throw new Error('Utility resilience segment lost its exact cadence bound')
  }
  if (
    realtime &&
    (result.wallMilliseconds < frames * 10 - 500 ||
      result.wallMilliseconds > frames * 10 + 10_000)
  ) {
    throw new Error('Utility resilience segment missed its 100Hz wall bound')
  }
  return result
}

function startPreviewRequest(epoch, label) {
  return requestEnvelope(`preview-${label}`, epoch, {
    type: 'startPreview',
    sessionId: 'microphone-resilience-soak',
    generation: 1,
  })
}

function connectRequest(epoch, label) {
  return requestEnvelope(`connect-${label}`, epoch, {
    type: 'connectMicrophone',
    sessionId: 'microphone-resilience-soak',
    generation: 1,
    options: {
      kind: 'microphone',
      requestId: `native-connect-${label}`,
      audioBitrate: 64_000,
      muted: false,
      participantIdentity: 'soak:microphone',
    },
    excludeProcessId: process.pid,
  })
}

function mutedRequest(epoch, label, muted) {
  return requestEnvelope(`muted-${label}-${muted}`, epoch, {
    type: 'setMicrophoneMuted',
    sessionId: 'microphone-resilience-soak',
    generation: 1,
    muted,
  })
}

function configureRequest(epoch, label) {
  return requestEnvelope(`configure-${label}`, epoch, {
    type: 'configureMicrophone',
    revision: 2,
    config: {
      deviceId: `soak-selected-${label}`,
      bypassSystemAudioInputProcessing: true,
      automaticGainControl: true,
      noiseSuppression: true,
      echoCancellation: true,
      inputVolume: 1,
      voiceGateEnabled: false,
      voiceGateThresholdDb: -50,
      voiceGateAutoThreshold: true,
    },
  })
}

async function waitForPublished(host, minimum) {
  const deadline = performance.now() + WAIT_MS
  let current = await snapshot(host)
  while (current.publishedFrames < minimum && performance.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 5))
    current = await snapshot(host)
  }
  if (current.publishedFrames < minimum) {
    throw new Error('Utility-owned publication sink did not drain')
  }
  return current
}

async function waitForPublicationQuiescence(host) {
  const deadline = performance.now() + WAIT_MS
  let previous = await snapshot(host)
  let stableSamples = 0
  while (performance.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10))
    const current = await snapshot(host)
    if (current.publishedFrames === previous.publishedFrames) {
      stableSamples += 1
      if (stableSamples >= 3) return current
    } else {
      stableSamples = 0
    }
    previous = current
  }
  throw new Error('Utility-owned publication sink did not become quiescent')
}

async function waitForHandleQuiescence(host, initial) {
  const deadline = performance.now() + WAIT_MS
  let previous = initial
  let stableSamples = 0
  while (performance.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10))
    const current = await snapshot(host)
    if (
      current.handles === previous.handles &&
      current.activeAttempts === 1 &&
      current.cleanupOwnedJobs === 0
    ) {
      stableSamples += 1
      if (stableSamples >= 3) return current
    } else {
      stableSamples = 0
    }
    previous = current
  }
  throw new Error('Utility-owned runtime handle baseline did not become quiescent')
}

function validateActiveSnapshot(value, expectedPid, epoch) {
  if (
    value.pid !== expectedPid ||
    value.activeAttempts !== 1 ||
    value.peakActiveAttempts !== 1 ||
    value.rejectedFrames !== 0 ||
    value.previewFrames <= 0 ||
    value.publishedFrames <= 0 ||
    value.cleanupOwnedJobs !== 0 ||
    value.lastDispatchedHostEpoch !== epoch
  ) {
    throw new Error(`Utility epoch ${epoch} lost real runtime ownership invariants`)
  }
}

function assertActiveHandleBound(snapshot, epoch) {
  if (
    !Number.isSafeInteger(snapshot.handles) ||
    snapshot.handles <= 0 ||
    snapshot.handles > MAX_ACTIVE_UTILITY_HANDLES
  ) {
    throw new Error(
      `Utility epoch ${epoch} exceeded its active handle bound: ` +
      `active=${snapshot.handles}, maximum=${MAX_ACTIVE_UTILITY_HANDLES}`,
    )
  }
}

async function startOwnedRuntime(host, epoch, label) {
  await host.waitForMessage(
    (message) => isMessage(
      message,
      (candidate) => candidate.type === 'ready' && candidate.runtime === 'media',
    ),
    'ready',
  )
  await requireAccepted(host, startPreviewRequest(epoch, label))
  await requireAccepted(host, connectRequest(epoch, label))
  const owned = await snapshot(host)
  if (owned.pid !== host.child.pid || owned.lastDispatchedHostEpoch !== epoch) {
    throw new Error('Utility process does not own the real MediaRuntime/MicrophoneActor')
  }
  return owned
}

async function runEpochWorkload(host, epoch, label, frames, realtime) {
  const chunk = frames / 3
  if (!Number.isSafeInteger(chunk)) throw new Error('Epoch frame count must split by three')
  const first = await runSegment(host, chunk, realtime)
  await requireAccepted(host, configureRequest(epoch, label))
  const afterConfigure = await waitForPublished(host, chunk)
  if (afterConfigure.attempts < 2 || afterConfigure.candidateFrames < 1) {
    throw new Error('Utility-owned actor skipped selected endpoint candidate PCM')
  }

  await requireAccepted(host, mutedRequest(epoch, label, true))
  const mutedStart = await waitForPublicationQuiescence(host)
  const mutedBaseline = mutedStart.publishedFrames
  const previewBeforeMuted = mutedStart.previewFrames
  await runSegment(host, chunk, realtime)
  const muted = await snapshot(host)
  if (
    muted.publishedFrames !== mutedBaseline ||
    muted.previewFrames < previewBeforeMuted + chunk
  ) {
    throw new Error('Utility-owned mute stopped preview or published muted PCM')
  }

  const discontinuitiesBefore = muted.publicationDiscontinuities
  await requireAccepted(host, mutedRequest(epoch, label, false))
  const final = await runSegment(host, chunk, realtime)
  const drained = await waitForPublished(host, mutedBaseline + chunk)
  if (drained.publicationDiscontinuities !== discontinuitiesBefore + 1) {
    throw new Error('Utility-owned unmute lost its publication discontinuity')
  }
  const quiescent = await waitForHandleQuiescence(host, drained)
  validateActiveSnapshot(quiescent, host.child.pid, epoch)
  return {
    frames: first.frames + chunk + final.frames,
    snapshot: quiescent,
  }
}

async function shutdownUtilityHost(host, epoch) {
  await requireAccepted(host, requestEnvelope(`stop-preview-${epoch}`, epoch, {
    type: 'stopPreview',
    sessionId: 'microphone-resilience-soak',
    generation: 1,
  }))
  await requireAccepted(host, requestEnvelope(`disconnect-${epoch}`, epoch, {
    type: 'disconnectMicrophone',
    sessionId: 'microphone-resilience-soak',
    generation: 2,
  }))
  await requireAccepted(host, requestEnvelope(`shutdown-${epoch}`, epoch, {
    type: 'shutdown',
  }))
  const code = await withTimeout(host.exit, `Utility epoch ${epoch} did not exit`)
  if (code !== 0) throw new Error(`Utility epoch ${epoch} exited ${code}`)
}

async function runMicrophoneResilience(electron, argv) {
  const options = parseOptions(argv)
  const addonPath = path.resolve(
    options.addon ?? path.join(
      __dirname, '..', 'build', 'microphone-resilience-addon', 'Release',
      'syrnike_media.node',
    ),
  )
  if (!existsSync(addonPath) || path.basename(addonPath) !== 'syrnike_media.node') {
    throw new Error(`Dedicated microphone resilience addon is missing: ${addonPath}`)
  }
  const artifact = path.resolve(
    options.artifact ?? path.join(
      __dirname, '..', 'artifacts', 'microphone-resilience',
      `${options.profile}-${Date.now()}-${process.pid}.log`,
    ),
  )
  mkdirSync(path.dirname(artifact), { recursive: true })
  writeFileSync(artifact, '')
  const log = (line) => {
    const text = `${line}\n`
    process.stdout.write(text)
    appendFileSync(artifact, text)
  }
  const hostPath = path.resolve(
    __dirname, '..', '..', '..', 'apps', 'desktop', 'out', 'utility',
    'microphone-resilience-host.cjs',
  )
  if (!existsSync(hostPath)) {
    throw new Error(`Microphone resilience utility host is missing: ${hostPath}`)
  }

  const framesPerHost = options.profile === 'production'
    ? PRODUCTION_FRAMES_PER_HOST
    : CI_FRAMES_PER_HOST
  const realtime = options.profile === 'production'
  const startedAt = performance.now()
  let hostA
  let hostB
  try {
    hostA = createUtilityHost(
      electron.utilityProcess, hostPath, addonPath, 'epoch-1', log,
    )
    await startOwnedRuntime(hostA, 1, 'a')
    const epochA = await runEpochWorkload(
      hostA, 1, 'a', framesPerHost, realtime,
    )
    assertActiveHandleBound(epochA.snapshot, 1)
    hostA.killIfRunning()
    await withTimeout(hostA.exit, 'Utility epoch 1 survived forced restart')

    hostB = createUtilityHost(
      electron.utilityProcess, hostPath, addonPath, 'epoch-2', log,
    )
    await startOwnedRuntime(hostB, 2, 'b')
    const stale = requestEnvelope('delayed-host-a-mute', 1, {
      type: 'setMicrophoneMuted',
      sessionId: 'microphone-resilience-soak',
      generation: 1,
      muted: true,
    })
    const staleReply = await sendRequest(hostB, stale)
    if (
      !isMessage(staleReply, (candidate) =>
        candidate.ok === false &&
        isMessage(candidate.error, (error) =>
          error.code === 'stale_host_epoch' && error.retryable === false,
        ),
      ) ||
      (await snapshot(hostB)).lastDispatchedHostEpoch !== 2
    ) {
      throw new Error('Replacement real runtime accepted an old-host envelope')
    }

    const epochB = await runEpochWorkload(
      hostB, 2, 'b', framesPerHost, realtime,
    )
    assertActiveHandleBound(epochB.snapshot, 2)
    const totalFrames = epochA.frames + epochB.frames
    const expectedFrames = options.profile === 'production' ? 180_000 : 60
    if (totalFrames !== expectedFrames) {
      throw new Error(`Utility-owned workload submitted ${totalFrames}/${expectedFrames}`)
    }
    await shutdownUtilityHost(hostB, 2)
    const wallMilliseconds = performance.now() - startedAt
    if (
      realtime &&
      (wallMilliseconds < 30 * 60_000 || wallMilliseconds > 31 * 60_000)
    ) {
      throw new Error('Production utility-owned workload missed its wall bound')
    }
    log(`microphone_resilience_runner_passed ${JSON.stringify({
      profile: options.profile,
      totalFrames,
      wallMilliseconds,
      utilityHostRestarts: 1,
      staleHostRequestsRejected: 1,
      actorPidA: epochA.snapshot.pid,
      actorPidB: epochB.snapshot.pid,
      activeHandles: {
        epochA: epochA.snapshot.handles,
        epochB: epochB.snapshot.handles,
      },
      activeHandleBound: MAX_ACTIVE_UTILITY_HANDLES,
    })}`)
    return { artifact, totalFrames }
  } finally {
    hostA?.killIfRunning()
    hostB?.killIfRunning()
  }
}

if (process.versions.electron && process.type === 'browser') {
  const electron = require('electron')
  electron.app.disableHardwareAcceleration()
  electron.app.whenReady().then(async () => {
    try {
      await runMicrophoneResilience(electron, process.argv.slice(2))
      electron.app.exit(0)
    } catch (error) {
      console.error(error)
      electron.app.exit(1)
    }
  })
}

module.exports = {
  parseOptions,
  requestEnvelope,
  assertActiveHandleBound,
  runMicrophoneResilience,
}
