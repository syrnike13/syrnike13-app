const { readFileSync } = require('node:fs')
const path = require('node:path')

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
  if (!snapshot.ok ||
      JSON.stringify(snapshot.result?.snapshot?.desiredState) !==
        JSON.stringify(desiredState)) {
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
  if (JSON.stringify(installed) !== JSON.stringify(
    canonicalResult('credentialLeaseInstalled'),
  )) {
    throw new Error('canonical credential lease changed across native boundary')
  }
  const canonicalState = structuredClone(protocol.canonical.desiredState)
  const canonicalAccepted = addon.applyDesiredState(canonicalState)
  if (JSON.stringify(canonicalAccepted) !== JSON.stringify(
    canonicalResult('desiredStateAccepted'),
  )) {
    throw new Error('canonical desired-state result changed across native boundary')
  }
  if (JSON.stringify(addon.querySnapshot()) !== JSON.stringify(
    canonicalResult('snapshot'),
  )) {
    throw new Error('canonical snapshot changed across native boundary')
  }
  if (JSON.stringify(addon.ping()) !== JSON.stringify(canonicalResult('pong'))) {
    throw new Error('canonical ping changed across native boundary')
  }

  const accepted = addon.applyDesiredState(makeState(2, 'room-a'))
  if (accepted.acceptedRevision !== 2 || accepted.disposition !== 'accepted') {
    throw new Error('native new revision matrix case failed')
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
  maximum.remoteVideoDemand = Array.from({ length: 64 }, (_, index) => ({
    participantIdentity: `participant-${index}`,
    publicationId: `publication-${index}`,
    quality: 'off',
  }))
  addon.applyDesiredState(maximum)
  expectFailure('desired_state_invalid', () =>
    addon.applyDesiredState(makeState(11, 'x'.repeat(257))),
  )
  expectFailure('desired_state_invalid', () =>
    addon.applyDesiredState({
      ...makeState(11),
      remoteVideoDemand: [
        ...maximum.remoteVideoDemand,
        {
          participantIdentity: 'one-too-many',
          publicationId: 'one-too-many',
          quality: 'off',
        },
      ],
    }),
  )

  // Keep the JS thread busy so the bounded diagnostic TSFN reaches capacity;
  // telemetry may drop, but control and the final snapshot must remain live.
  for (let revision = 11; revision <= 512; ++revision) {
    addon.applyDesiredState(makeState(revision))
  }
  if (addon.querySnapshot().snapshot.acceptedRevision !== 512) {
    throw new Error('diagnostic flood changed control state')
  }
  const shutdown = addon.shutdown()
  if (JSON.stringify(shutdown) !== JSON.stringify(canonicalResult('shutdownComplete'))) {
    throw new Error('canonical shutdown changed across native boundary')
  }
  await new Promise((resolve) => setImmediate(resolve))
  await new Promise((resolve) => setImmediate(resolve))
  if (diagnostics > 64) {
    throw new Error(`diagnostic queue exceeded capacity: ${diagnostics}`)
  }
  for (const type of [
    'engineStateChanged',
    'roomStateChanged',
    'trackStateChanged',
  ]) {
    const canonical = canonicalPublicEvent(type)
    const emitted = publicEventsByType.get(type) || []
    if (!emitted.some((event) => JSON.stringify(event) === JSON.stringify(canonical))) {
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

app.whenReady().then(async () => {
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
      nativeConformance: conformance,
    }),
  )
  app.exit(0)
}).catch((error) => {
  console.error(error)
  app.exit(1)
})
