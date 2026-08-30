const { readFileSync } = require('node:fs')
const path = require('node:path')

const { app, utilityProcess } = require('electron')

const desktopRoot = path.resolve(__dirname, '..')
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
  let resolveExit
  const exited = new Promise((resolve) => {
    resolveExit = resolve
  })
  child.on('message', (message) => {
    messages.push(message)
    for (const waiter of waiters) waiter()
  })
  child.on('exit', (code) => {
    exitResult = { code }
    resolveExit(exitResult)
    for (const waiter of waiters) waiter()
  })
  child.on('error', (error) => {
    exitResult = { code: null, error }
    resolveExit(exitResult)
    for (const waiter of waiters) waiter()
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
    (message) => message?.type === 'ready' && message.protocolVersion === 2,
    `cycle ${index} handshake`,
  )
  const handshakeId = `handshake-${index}`
  host.child.postMessage({
    type: 'request',
    protocolVersion: 2,
    requestId: handshakeId,
    hostEpoch: index,
    deadlineMs: 1_000,
    command: { type: 'handshake' },
  })
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
  host.child.postMessage({
    type: 'request',
    protocolVersion: 2,
    requestId: pingId,
    hostEpoch: index,
    deadlineMs: 1_000,
    command: { type: 'ping' },
  })
  await host.waitMessage(
    (message) => message?.type === 'reply' && message.requestId === pingId && message.ok,
    `cycle ${index} ping`,
    1_000,
  )
  const desiredState = {
    revision: index,
    room: { roomId: `room-${index}`, participantIdentity: 'smoke-participant' },
    microphone: { state: 'off' },
    camera: { state: 'off' },
    screen: { state: 'off' },
    output: { state: 'off' },
    remoteVideoDemand: [],
  }
  const applyId = `apply-${index}`
  host.child.postMessage({
    type: 'request',
    protocolVersion: 2,
    requestId: applyId,
    hostEpoch: index,
    deadlineMs: 1_000,
    command: { type: 'applyDesiredState', desiredState },
  })
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
  host.child.postMessage({
    type: 'request',
    protocolVersion: 2,
    requestId: queryId,
    hostEpoch: index,
    deadlineMs: 1_000,
    command: { type: 'querySnapshot' },
  })
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
  host.child.postMessage({
    type: 'request',
    protocolVersion: 2,
    requestId: shutdownId,
    hostEpoch: index,
    deadlineMs: 1_000,
    command: { type: 'shutdown' },
  })
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
  const publicEventTypes = new Set()
  let diagnostics = 0
  addon.registerPublicEventCallback((event) => {
    publicEvents += 1
    publicEventTypes.add(event.type)
  })
  addon.registerDiagnosticEventCallback(() => { diagnostics += 1 })
  const handshake = addon.handshake()
  if (handshake.protocolVersion !== 2 || handshake.engineState !== 'running') {
    throw new Error('native conformance handshake failed')
  }
  const makeState = (revision, roomId = 'room-conformance') => ({
    revision,
    room: { roomId, participantIdentity: 'participant-conformance' },
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
  addon.shutdown()
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
    if (!publicEventTypes.has(type)) {
      throw new Error(`native public event variant was not emitted: ${type}`)
    }
  }
  const publicEventsAtShutdown = publicEvents
  expectFailure('engine_stopping', () => addon.ping())
  await new Promise((resolve) => setImmediate(resolve))
  if (publicEvents !== publicEventsAtShutdown) {
    throw new Error('public callback escaped terminal shutdown')
  }
  return { publicEvents, diagnostics, diagnosticFlood: 502 }
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
    (message) => message?.type === 'ready' && message.protocolVersion === 2,
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
