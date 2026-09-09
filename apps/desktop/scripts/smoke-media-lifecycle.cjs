const { readFileSync } = require('node:fs')
const path = require('node:path')
const { isDeepStrictEqual } = require('node:util')
const { execFile, execFileSync, fork } = require('node:child_process')

const { app, utilityProcess } = require('electron')

const desktopRoot = path.resolve(__dirname, '..')
const protocol = JSON.parse(
  readFileSync(
    path.resolve(desktopRoot, '..', '..', 'packages', 'windows-media-engine', 'protocol', 'media-lifecycle.json'),
    'utf8',
  ),
)
const MEDIA_UTILITY_BOOTSTRAP_MESSAGE = protocol.electron.utilityBootstrapMessage
const canonicalRequest = (commandType, requestId, hostEpoch) => {
  const fixture = protocol.canonical.requests.find(
    (request) => request.command.type === commandType,
  )
  if (!fixture) throw new Error(`Missing canonical ${commandType} request`)
  return {
    ...structuredClone(fixture),
    requestId,
    hostEpoch,
  }
}
const canonicalResult = (resultType) => {
  const fixture = protocol.canonical.successReplies.find(
    (reply) => reply.result.type === resultType,
  )
  if (!fixture) throw new Error(`Missing canonical ${resultType} result`)
  return structuredClone(fixture.result)
}
const canonicalPublicEvent = (eventType) => {
  const fixture = protocol.canonical.publicEventMessages.find(
    (message) => message.event.type === eventType,
  )
  if (!fixture) throw new Error(`Missing canonical ${eventType} event`)
  return structuredClone(fixture.event)
}
const hostPath = path.resolve(desktopRoot, 'out', 'utility', 'media-host.cjs')
const mediaRoot = path.resolve(
  desktopRoot,
  'out',
  'media-native',
  'win32-x64',
)
const modulePath = path.resolve(mediaRoot, 'windows_media.node')
const manifest = JSON.parse(
  readFileSync(path.resolve(mediaRoot, 'media-manifest.json'), 'utf8'),
)

const baseEnvironment = {
  APPDATA: process.env.APPDATA,
  LOCALAPPDATA: process.env.LOCALAPPDATA,
  SystemRoot: process.env.SystemRoot,
  TEMP: process.env.TEMP,
  TMP: process.env.TMP,
  USERPROFILE: process.env.USERPROFILE,
  WINDIR: process.env.WINDIR,
  SYRNIKE_MEDIA_MODULE_PATH: modulePath,
  SYRNIKE_MEDIA_ROOT: mediaRoot,
  SYRNIKE_MEDIA_APP_VERSION: manifest.appVersion,
  SYRNIKE_MEDIA_RELEASE_CHANNEL: manifest.releaseChannel,
  SYRNIKE_MEDIA_PROTOCOL_VERSION: String(manifest.protocolVersion),
  SYRNIKE_MEDIA_COMMIT_SHA: manifest.commitSha,
}

function boundedTimeout(label, milliseconds, operation) {
  let timer
  return Promise.race([
    operation.finally(() => clearTimeout(timer)),
    new Promise((_, reject) => {
      timer = setTimeout(
        () => reject(new Error(`${label} exceeded ${milliseconds}ms`)),
        milliseconds,
      )
    }),
  ])
}

function spawnHost(overrides = {}) {
  const child = utilityProcess.fork(hostPath, [], {
    serviceName: 'syrnike-media-lifecycle-smoke',
    stdio: ['ignore', 'ignore', 'pipe'],
    env: { ...baseEnvironment, ...overrides },
  })
  const messages = []
  const waiters = new Set()
  let exitResult
  let bootstrapTimer
  let resolveExit
  const exited = new Promise((resolve) => {
    resolveExit = resolve
  })
  child.on('message', (message) => {
    clearInterval(bootstrapTimer)
    messages.push(message)
    for (const waiter of waiters) waiter()
  })
  child.on('exit', (code) => {
    clearInterval(bootstrapTimer)
    exitResult = { code }
    resolveExit(exitResult)
    for (const waiter of waiters) waiter()
  })
  child.on('error', (error) => {
    clearInterval(bootstrapTimer)
    exitResult = { code: null, error }
    resolveExit(exitResult)
    for (const waiter of waiters) waiter()
  })
  child.on('spawn', () => {
    const bootstrap = () => child.postMessage(MEDIA_UTILITY_BOOTSTRAP_MESSAGE)
    bootstrapTimer = setInterval(bootstrap, 25)
    bootstrapTimer.unref?.()
    bootstrap()
  })
  const waitMessage = (predicate, label, timeoutMs = 5_000) =>
    boundedTimeout(
      label,
      timeoutMs,
      new Promise((resolve, reject) => {
        const inspect = () => {
          const index = messages.findIndex(predicate)
          if (index >= 0) {
            const [message] = messages.splice(index, 1)
            waiters.delete(inspect)
            resolve(message)
            return
          }
          if (exitResult) {
            waiters.delete(inspect)
            reject(
              new Error(
                `${label} host exited first: ${exitResult.error || exitResult.code}`,
              ),
            )
          }
        }
        waiters.add(inspect)
        inspect()
      }),
    )
  return { child, exited, waitMessage }
}

async function lifecycleCycle(index) {
  const host = spawnHost()
  await host.waitMessage(
    (message) =>
      message?.type === 'ready' && message.protocolVersion === protocol.version,
    `cycle ${index} handshake`,
  )
  const handshakeId = `handshake-${index}`
  host.child.postMessage(canonicalRequest('handshake', handshakeId, index))
  await host.waitMessage(
    (message) =>
      message?.type === 'reply' &&
      message.requestId === handshakeId &&
      message.ok &&
      message.result?.type === 'handshake',
    `cycle ${index} handshake command`,
    1_000,
  )
  const pingId = `ping-${index}`
  host.child.postMessage(canonicalRequest('ping', pingId, index))
  await host.waitMessage(
    (message) => message?.type === 'reply' && message.requestId === pingId && message.ok,
    `cycle ${index} ping`,
    1_000,
  )
  const leaseId = `lease-${index}`
  const leaseRequest = canonicalRequest('installCredentialLease', leaseId, index)
  leaseRequest.command.lease.leaseId = leaseId
  host.child.postMessage(leaseRequest)
  const installed = await host.waitMessage(
    (message) => message?.type === 'reply' && message.requestId === leaseId,
    `cycle ${index} credential lease`,
    1_000,
  )
  if (!installed.ok || installed.result?.type !== 'credentialLeaseInstalled') {
    throw new Error(`cycle ${index} canonical credential lease was rejected`)
  }
  const desiredState = structuredClone(protocol.canonical.desiredState)
  desiredState.revision = index
  const applyId = `apply-${index}`
  const applyRequest = canonicalRequest('applyDesiredState', applyId, index)
  applyRequest.command.desiredState = desiredState
  host.child.postMessage(applyRequest)
  const accepted = await host.waitMessage(
    (message) => message?.type === 'reply' && message.requestId === applyId,
    `cycle ${index} apply`,
    1_000,
  )
  if (!accepted.ok || accepted.result?.acceptedRevision !== index) {
    throw new Error(
      `cycle ${index} desired state was not accepted: ${JSON.stringify(accepted)}`,
    )
  }
  const queryId = `query-${index}`
  host.child.postMessage(canonicalRequest('querySnapshot', queryId, index))
  const snapshot = await host.waitMessage(
    (message) => message?.type === 'reply' && message.requestId === queryId,
    `cycle ${index} query`,
    1_000,
  )
  if (!snapshot.ok || !isDeepStrictEqual(snapshot.result?.snapshot?.desiredState, desiredState)) {
    throw new Error(`cycle ${index} TS/native golden snapshot changed`)
  }
  const shutdownId = `shutdown-${index}`
  host.child.postMessage(canonicalRequest('shutdown', shutdownId, index))
  await host.waitMessage(
    (message) =>
      message?.type === 'reply' && message.requestId === shutdownId && message.ok,
    `cycle ${index} shutdown reply`,
    1_500,
  )
  const exit = await boundedTimeout(
    `cycle ${index} clean exit`,
    1_500,
    host.exited,
  )
  if (exit.code !== 0) throw new Error(`cycle ${index} exited with ${exit.code}`)
}

async function nativeConformance() {
  const addon = require(modulePath)
  let publicEvents = 0
  const publicEventsByType = new Map()
  let diagnostics = 0
  addon.registerPublicEventCallback((event) => {
    publicEvents += 1
    const events = publicEventsByType.get(event.type) || []
    events.push(structuredClone(event))
    publicEventsByType.set(event.type, events)
  })
  addon.registerDiagnosticEventCallback(() => { diagnostics += 1 })
  const handshake = addon.handshake()
  if (
    handshake.protocolVersion !== protocol.version ||
    handshake.engineState !== 'running'
  ) {
    throw new Error('native conformance handshake failed')
  }
  const makeState = (revision, roomId = 'room-conformance') => ({
    revision,
    room: {
      roomId,
      participantIdentity: 'participant-conformance',
      credentialLeaseId: 'conformance-lease',
    },
    microphone: { state: 'off' },
    camera: { state: 'off' },
    screen: { state: 'off' },
    output: { state: 'off' },
    remoteVideoDemand: [],
    rendererId: null,
  })
  const expectFailure = (code, operation) => {
    try {
      operation()
    } catch (error) {
      if (error?.code === code) return
      throw new Error(`expected ${code}, received ${error?.code || error}`)
    }
    throw new Error(`expected ${code}, operation succeeded`)
  }

  const installed = addon.installCredentialLease(
    structuredClone(protocol.canonical.credentialLease),
  )
  if (!isDeepStrictEqual(installed, canonicalResult('credentialLeaseInstalled'))) {
    throw new Error('canonical credential lease changed across native boundary')
  }
  const canonicalState = structuredClone(protocol.canonical.desiredState)
  const canonicalAccepted = addon.applyDesiredState(canonicalState)
  if (!isDeepStrictEqual(canonicalAccepted, canonicalResult('desiredStateAccepted'))) {
    throw new Error('canonical desired-state result changed across native boundary')
  }
  // Acceptance is synchronous; independent product owners settle their actual
  // path revisions asynchronously. Compare the complete settled golden state.
  const snapshotDeadline = Date.now() + 1_000
  let canonicalSnapshot = addon.querySnapshot()
  while (!isDeepStrictEqual(canonicalSnapshot, canonicalResult('snapshot')) &&
      Date.now() < snapshotDeadline) {
    await new Promise(resolve => setTimeout(resolve, 10))
    canonicalSnapshot = addon.querySnapshot()
  }
  if (!isDeepStrictEqual(canonicalSnapshot, canonicalResult('snapshot'))) {
    throw new Error(`canonical snapshot changed across native boundary: ${JSON.stringify(canonicalSnapshot)}`)
  }
  if (!isDeepStrictEqual(addon.ping(), canonicalResult('pong'))) {
    throw new Error('canonical ping changed across native boundary')
  }

  const accepted = addon.applyDesiredState(makeState(2, 'room-a'))
  if (accepted.acceptedRevision !== 2 || accepted.disposition !== 'accepted') {
    throw new Error('native new revision matrix case failed')
  }
  // The missing-credential failure belongs to actual Room reconciliation,
  // which must finish before the next desired revision supersedes this one.
  const roomFailureDeadline = Date.now() + 1_000
  while (!(publicEventsByType.get('roomStateChanged') || [])
      .some(event => event.revision === 2 && event.state === 'failed') &&
      Date.now() < roomFailureDeadline) {
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  const duplicate = addon.applyDesiredState(makeState(2, 'room-a'))
  if (duplicate.disposition !== 'duplicate') {
    throw new Error('native duplicate revision matrix case failed')
  }
  expectFailure('revision_conflict', () =>
    addon.applyDesiredState(makeState(2, 'room-b')),
  )
  expectFailure('stale_revision', () =>
    addon.applyDesiredState(makeState(1, 'room-old')),
  )
  addon.applyDesiredState(makeState(9, 'room-gapped'))
  expectFailure('desired_state_invalid', () =>
    addon.applyDesiredState({ ...makeState(10), camera: { state: 'on' } }),
  )
  if (addon.querySnapshot().snapshot.acceptedRevision !== 9) {
    throw new Error('invalid native snapshot partially applied')
  }

  const maximum = makeState(10, 'x'.repeat(256))
  maximum.rendererId = 'renderer-conformance'
  maximum.remoteVideoDemand = Array.from({ length: 64 }, (_, index) => ({
    participantIdentity: `participant-${index}`,
    publicationId: `publication-${index}`,
  }))
  addon.applyDesiredState(maximum)
  expectFailure('desired_state_invalid', () =>
    addon.applyDesiredState(makeState(11, 'x'.repeat(257))),
  )
  expectFailure('desired_state_invalid', () =>
    addon.applyDesiredState({
      ...makeState(11),
      rendererId: maximum.rendererId,
      remoteVideoDemand: [
        ...maximum.remoteVideoDemand,
        {
          participantIdentity: 'one-too-many',
          publicationId: 'one-too-many',
        },
      ],
    }),
  )

  // Keep the JS thread busy so the bounded diagnostic TSFN reaches capacity;
  // telemetry may drop, but control and the final snapshot must remain live.
  const diagnosticsBeforeFlood = diagnostics
  for (let revision = 11; revision <= 512; ++revision) {
    addon.applyDesiredState(makeState(revision))
  }
  if (addon.querySnapshot().snapshot.acceptedRevision !== 512) {
    throw new Error('diagnostic flood changed control state')
  }
  const shutdown = addon.shutdown()
  if (!isDeepStrictEqual(shutdown, canonicalResult('shutdownComplete'))) {
    throw new Error('canonical shutdown changed across native boundary')
  }
  await new Promise((resolve) => setImmediate(resolve))
  await new Promise((resolve) => setImmediate(resolve))
  const floodDiagnostics = diagnostics - diagnosticsBeforeFlood
  if (floodDiagnostics > 64) {
    throw new Error(`diagnostic queue exceeded capacity: ${floodDiagnostics}`)
  }
  for (const type of [
    'engineStateChanged',
    'roomStateChanged',
    'trackStateChanged',
  ]) {
    const canonical = canonicalPublicEvent(type)
    // Canonical transport fixtures also exercise optional terminal-incident
    // metadata. This scenario rejects a missing credential lease before any
    // Room operation starts, so it has no native terminal incident to cite.
    if (type === 'roomStateChanged') {
      delete canonical.failure.causeSequence
      delete canonical.failure.causeTimestampMs
    }
    const emitted = publicEventsByType.get(type) || []
    // Sequence is monotonic delivery identity, not a fixed cross-owner schedule.
    if (!emitted.some((event) => isDeepStrictEqual({ ...event, sequence: canonical.sequence }, canonical))) {
      throw new Error(
        `native ${type} event changed across the C++/JS boundary: ${JSON.stringify(emitted)}`,
      )
    }
  }
  const publicEventsAtShutdown = publicEvents
  expectFailure('engine_stopping', () => addon.ping())
  await new Promise((resolve) => setImmediate(resolve))
  if (publicEvents !== publicEventsAtShutdown) {
    throw new Error('public callback escaped terminal shutdown')
  }
  return {
    publicEvents,
    diagnostics,
    floodDiagnostics,
    diagnosticFlood: 502,
    canonicalPublicEvents: [
      'engineStateChanged',
      'roomStateChanged',
      'trackStateChanged',
    ],
  }
}

async function incompatibleHandshake() {
  const host = spawnHost({ SYRNIKE_MEDIA_PROTOCOL_VERSION: '999' })
  const ready = await host.waitMessage(
    (message) => message?.type === 'ready',
    'incompatible handshake',
  )
  if (
    ready.protocolVersion !== 0 ||
    ready.failure?.code !== 'protocol_incompatible'
  ) {
    throw new Error('incompatible handshake was not rejected with a typed failure')
  }
  const exit = await boundedTimeout('incompatible host exit', 1_500, host.exited)
  if (exit.code === 0) throw new Error('incompatible host exited successfully')
}

async function unexpectedExit() {
  const host = spawnHost()
  await host.waitMessage(
    (message) =>
      message?.type === 'ready' && message.protocolVersion === protocol.version,
    'unexpected-exit handshake',
  )
  process.kill(host.child.pid)
  const exit = await boundedTimeout('unexpected host exit', 1_500, host.exited)
  const failure = exit.code === 0 ? undefined : { code: 'unexpected_exit' }
  if (failure?.code !== 'unexpected_exit') {
    throw new Error('forced utility termination was not classified as unexpected_exit')
  }
  // Prove that the Electron main process remains usable after the fault.
  await lifecycleCycle(10_001)
}

const brokerPath = process.env.SYRNIKE_MEDIA_BROKER_TEST_PATH || path.resolve(mediaRoot, 'windows_media_texture_broker.node')

async function stalledUtilityTermination(action = 'terminate') {
  const broker = require(brokerPath)
  const child = !app ? forkGuardFixture('--guard-orphan') : utilityProcess.fork(__filename, ['--stalled-utility'], {
    serviceName: 'syrnike-media-termination-smoke', stdio: 'ignore',
  })
  const exited = new Promise(resolve => child.once('exit', resolve))
  await boundedTimeout('stalled utility spawn', 2_000,
    new Promise(resolve => child.once('spawn', resolve)))
  const guard = broker.openUtilityProcess(child.pid)
  let closed = false
  let receiver
  try {
    receiver = broker.openReceiverProcess(child.pid)
    const releasedReference = broker.openReceiverProcess(child.pid)
    releasedReference.close()
    releasedReference.close()
    const stalled = new Promise(resolve => child.once('message', resolve))
    if (app) child.postMessage('stall')
    await boundedTimeout('utility stall', 2_000, stalled)
    if (guard.hasExited()) throw new Error('stalled fixture unexpectedly exited')
    if (receiver.hasExited()) throw new Error('closing a receiver reference terminated the fixture')
    const stoppedAt = performance.now()
    if (action === 'close') {
      guard.close()
      guard.close()
      closed = true
    } else {
      guard.terminate()
      guard.terminate()
    }
    // Electron's exit notification can precede the Windows process handle
    // becoming signaled, particularly when a Job Object closes the process.
    // Require both observations within the same termination budget.
    await boundedTimeout('confirmed utility termination', 2_000, Promise.all([
      exited,
      (async () => {
        while (!receiver.hasExited()) await new Promise(resolve => setTimeout(resolve, 10))
        if (!closed && !guard.hasExited()) throw new Error('utility guard missed confirmed process exit')
      })(),
    ]))
    return performance.now() - stoppedAt
  } finally {
    receiver?.close()
    if (!closed) {
      try { if (!guard.hasExited()) guard.terminate() } finally { guard.close() }
    }
  }
}

function forkGuardFixture(mode) {
  return fork(__filename, [mode], {
    execPath: process.execPath, windowsHide: true, stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
  })
}

async function nativeProcessExitDeadline() {
  const child = forkGuardFixture('--exit-deadline-child')
  const closed = new Promise(resolve => child.once('close', resolve))
  let receiver
  try {
    const ready = await boundedTimeout('exit deadline fixture ready', 2_000,
      new Promise((resolve, reject) => { child.once('message', resolve); child.once('error', reject) }))
    if (ready?.validated !== true) throw new Error('Exit deadline validation failed')
    receiver = require(brokerPath).openReceiverProcess(child.pid)
    const startedAt = performance.now()
    child.send('arm')
    await boundedTimeout('native deadline through blocked JavaScript', 1_500, Promise.all([
      closed,
      (async () => {
        while (!receiver.hasExited()) await new Promise(resolve => setTimeout(resolve, 10))
      })(),
    ]))
    const elapsedMs = performance.now() - startedAt
    if (child.exitCode !== 0 || elapsedMs < 400)
      throw new Error(`Unexpected native deadline exit: ${child.exitCode}, ${elapsedMs} ms`)
    return { elapsedMs, invalidArgumentsRejected: true, repeatedArmDidNotExtend: true,
      blockedJavaScript: true, kernelExitConfirmed: true }
  } finally {
    if (child.exitCode === null) child.kill()
    receiver?.close()
  }
}

async function guardParentExit() {
  const parent = forkGuardFixture('--guard-parent')
  const closed = new Promise(resolve => parent.once('close', resolve))
  let childGuard
  try {
    const message = await boundedTimeout('guard parent ready', 4_000,
      new Promise((resolve, reject) => { parent.once('message', resolve); parent.once('error', reject) }))
    if (!Number.isSafeInteger(message?.pid) || message.pid <= 0) throw new Error('Guard child PID missing')
    childGuard = require(brokerPath).openUtilityProcess(message.pid)
    if (childGuard.hasExited()) throw new Error('Guard child exited before its parent')
    // Terminate the parent without running JavaScript/N-API finalizers.
    const stoppedAt = performance.now()
    parent.kill()
    await boundedTimeout('guard parent and orphan exit', 2_000, Promise.all([
      closed,
      (async () => {
        while (!childGuard.hasExited()) await new Promise(resolve => setTimeout(resolve, 10))
      })(),
    ]))
    return performance.now() - stoppedAt
  } finally {
    if (parent.exitCode === null) parent.kill()
    if (childGuard) {
      try { if (!childGuard.hasExited()) childGuard.terminate() } finally { childGuard.close() }
    }
  }
}

function processResources() {
  const command = `$sample = Get-Process -Id ${process.pid}; [pscustomobject]@{handles=$sample.HandleCount; threads=$sample.Threads.Count; privateBytes=$sample.PrivateMemorySize64} | ConvertTo-Json -Compress`
  const result = JSON.parse(execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], {
    encoding: 'utf8', windowsHide: true,
  }))
  for (const key of ['handles', 'threads', 'privateBytes']) {
    if (!Number.isSafeInteger(result[key]) || result[key] < 0) throw new Error(`Invalid process resource ${key}`)
  }
  if (process.env.SYRNIKE_MEDIA_HANDLE_DIAGNOSTIC) {
    const summary = execFileSync(process.env.SYRNIKE_MEDIA_HANDLE_DIAGNOSTIC,
      ['-nobanner', '-s', '-p', String(process.pid)], { encoding: 'utf8', windowsHide: true })
    result.handleTypes = Object.fromEntries([...summary.matchAll(/^\s+([^:\r\n]+?)\s*:\s*(\d+)\s*$/gm)]
      .map(match => [match[1].trim(), Number(match[2])]))
  }
  return result
}

async function isolatedGuardResources() {
  const stdout = await new Promise((resolve, reject) => {
    execFile(process.execPath, [__filename, '--process-guard-only'], {
      windowsHide: true, env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, timeout: 600_000,
    }, (error, output) => error ? reject(error) : resolve(output))
  })
  const report = JSON.parse(stdout.trim().split(/\r?\n/).at(-1))
  if (report.status !== 'pass') throw new Error('Isolated process guard proof failed')
  return report.processGuard
}

if (process.argv.includes('--exit-deadline-child')) {
  const broker = require(brokerPath)
  for (const value of [undefined, null, '500', 0, -1, 0.5, 4001, NaN, Infinity]) {
    let rejected = false
    try { broker.armProcessExitDeadline(value) } catch (error) { rejected = error instanceof TypeError }
    if (!rejected) throw new Error('Invalid native deadline was accepted')
  }
  process.once('message', () => {
    broker.armProcessExitDeadline(500)
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 200)
    broker.armProcessExitDeadline(4_000)
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 60_000)
    process.exit(1)
  })
  process.send({ validated: true })
} else if (process.argv.includes('--guard-orphan')) {
  process.send({ ready: true })
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 60_000)
} else if (process.argv.includes('--guard-parent')) {
  const child = forkGuardFixture('--guard-orphan')
  const guard = require(brokerPath).openUtilityProcess(child.pid)
  child.once('message', () => process.send({ pid: child.pid }))
  // Retain the job for the entire parent lifetime, including its abrupt exit.
  process.on('message', () => guard.hasExited())
} else if (process.argv.includes('--stalled-utility')) {
  process.parentPort.on('message', () => {
    process.parentPort.postMessage('stalled')
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 60_000)
  })
} else (app ? app.whenReady() : Promise.resolve()).then(async () => {
  const processExitDeadline = await nativeProcessExitDeadline()
  if (process.argv.includes('--process-exit-deadline-only')) {
    console.info(JSON.stringify({ status: 'pass', processExitDeadline }))
    if (app) app.exit(0)
    else process.exit(0)
    return
  }
  const isolatedResources = app ? await isolatedGuardResources() : null
  const guardResults = { terminate: 0, close: 0, parentExit: 0 }
  const maximumExitMs = { terminate: 0, close: 0, parentExit: 0 }
  console.info(JSON.stringify({ processGuardStarted: true, runtime: app ? 'electron' : 'node' }))
  const cold = processResources()
  // Exercise the full repeated workload before measuring the Electron process,
  // whose background services allocate handles during the initial batch.
  const warmupRepetitions = 100
  for (let warmup = 0; warmup < warmupRepetitions; warmup += 1) {
    await stalledUtilityTermination()
    await stalledUtilityTermination('close')
    await guardParentExit()
  }
  const baseline = processResources()
  console.info(JSON.stringify({ processGuardWarmup: warmupRepetitions, cold, baseline }))
  for (let attempt = 0; attempt < 100; attempt += 1) {
    maximumExitMs.terminate = Math.max(maximumExitMs.terminate, await stalledUtilityTermination())
    guardResults.terminate += 1
    maximumExitMs.close = Math.max(maximumExitMs.close, await stalledUtilityTermination('close'))
    guardResults.close += 1
    maximumExitMs.parentExit = Math.max(maximumExitMs.parentExit, await guardParentExit())
    guardResults.parentExit += 1
    if ((attempt + 1) % 25 === 0)
      console.info(JSON.stringify({ processGuardCheckpoint: attempt + 1, resources: processResources() }))
  }
  const final = processResources()
  const resourceDelta = Object.fromEntries(['handles', 'threads', 'privateBytes'].map(key => [key, final[key] - baseline[key]]))
  const processGuard = { warmupRepetitions, repetitions: guardResults, maximumExitMs,
    resourceScope: app ? 'electron-integration' : 'isolated-kernel-guard', isolatedResources,
    resources: { cold, baseline, final, delta: resourceDelta } }
  // Chromium owns unrelated background services. Require exact resource return
  // in the isolated kernel-guard process and retain integration deltas separately.
  if (!app && (resourceDelta.handles > 0 || resourceDelta.threads > 0))
    throw new Error(`Process guard resource growth: ${JSON.stringify(processGuard)}`)
  if (process.argv.includes('--process-guard-only')) {
    console.info(JSON.stringify({ status: 'pass', processGuard }))
    if (app) app.exit(0)
    else process.exit(0)
    return
  }
  const conformance = await nativeConformance()
  for (let cycle = 1; cycle <= 50; ++cycle) await lifecycleCycle(cycle)
  await incompatibleHandshake()
  await unexpectedExit()
  console.info(
    JSON.stringify({
      status: 'pass',
      lifecycleCycles: 50,
      incompatibleHandshake: 'rejected',
      unexpectedExit: 'unexpected_exit',
      stalledUtilityTermination: 'kernel_exit_confirmed',
      processGuard,
      processExitDeadline,
      nativeConformance: conformance,
    }),
  )
  app.exit(0)
}).catch((error) => {
  console.error(error)
  if (app) app.exit(1)
  else process.exit(1)
})
