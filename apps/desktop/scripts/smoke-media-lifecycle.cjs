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
    (message) => message?.type === 'ready' && message.protocolVersion === 1,
    `cycle ${index} handshake`,
  )
  const pingId = `ping-${index}`
  host.child.postMessage({
    type: 'request',
    requestId: pingId,
    hostEpoch: index,
    command: { type: 'ping' },
  })
  await host.waitMessage(
    (message) => message?.type === 'reply' && message.requestId === pingId && message.ok,
    `cycle ${index} ping`,
    1_000,
  )
  const shutdownId = `shutdown-${index}`
  host.child.postMessage({
    type: 'request',
    requestId: shutdownId,
    hostEpoch: index,
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

async function incompatibleHandshake() {
  const host = spawnHost({ SYRNIKE_MEDIA_PROTOCOL_VERSION: '999' })
  const ready = await host.waitMessage(
    (message) => message?.type === 'ready',
    'incompatible handshake',
  )
  if (
    ready.protocolVersion !== 0 ||
    ready.failure?.code !== 'media_host_environment_invalid'
  ) {
    throw new Error('incompatible handshake was not rejected with a typed failure')
  }
  const exit = await boundedTimeout('incompatible host exit', 1_500, host.exited)
  if (exit.code === 0) throw new Error('incompatible host exited successfully')
}

async function unexpectedExit() {
  const host = spawnHost()
  await host.waitMessage(
    (message) => message?.type === 'ready' && message.protocolVersion === 1,
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
  for (let cycle = 1; cycle <= 50; ++cycle) await lifecycleCycle(cycle)
  await incompatibleHandshake()
  await unexpectedExit()
  console.info(
    JSON.stringify({
      status: 'pass',
      lifecycleCycles: 50,
      incompatibleHandshake: 'rejected',
      unexpectedExit: 'unexpected_exit',
    }),
  )
  app.exit(0)
}).catch((error) => {
  console.error(error)
  app.exit(1)
})
