const path = require('node:path')
const { app, utilityProcess } = require('electron')

const repoRoot = path.resolve(__dirname, '..', '..', '..')
const utilityRoot = path.resolve(repoRoot, 'apps', 'desktop', 'out', 'utility')
const nativeRoot = path.resolve(
  repoRoot,
  'apps',
  'desktop',
  'out',
  'native',
  'win32-x64',
)
const manifest = require(path.resolve(nativeRoot, 'native-manifest.json'))
const utilityEnvironment = Object.fromEntries(
  ['APPDATA', 'LOCALAPPDATA', 'SystemRoot', 'TEMP', 'TMP', 'USERPROFILE', 'WINDIR']
    .flatMap((key) => (process.env[key] ? [[key, process.env[key]]] : [])),
)

app.whenReady().then(async () => {
  try {
    await smokeRuntime('media', 'media-host.cjs', 'syrnike_media.node')
    await smokeRuntime('hooks', 'hooks-host.cjs', 'syrnike_hooks.node')
    await smokeRuntime(
      'media',
      'media-host.cjs',
      'syrnike_media.node',
      true,
    )
    console.info('[desktop-native] Electron utility-process smoke passed')
    app.exit(0)
  } catch (error) {
    console.error(error)
    app.exit(1)
  }
})

function smokeRuntime(runtime, hostName, addonName, injectCrash = false) {
  return new Promise((resolve, reject) => {
    const child = utilityProcess.fork(path.resolve(utilityRoot, hostName), [], {
      serviceName: `syrnike-${runtime}-smoke`,
      stdio: 'ignore',
      env: {
        ...utilityEnvironment,
        SYRNIKE_NATIVE_ROOT: nativeRoot,
        SYRNIKE_NATIVE_RUNTIME_KIND: runtime,
        SYRNIKE_NATIVE_MODULE_PATH: path.resolve(nativeRoot, addonName),
        SYRNIKE_NATIVE_APP_VERSION: manifest.appVersion,
        SYRNIKE_NATIVE_RELEASE_CHANNEL: manifest.releaseChannel,
        SYRNIKE_NATIVE_CONTRACT_VERSION: String(manifest.contractVersion),
        SYRNIKE_NATIVE_LIVEKIT_VERSION: manifest.liveKitVersion,
        SYRNIKE_NATIVE_COMMIT_SHA: manifest.commitSha,
      },
    })
    const commandRequestId = `${runtime}-smoke-command`
    const shutdownRequestId = `${runtime}-smoke-shutdown`
    let phase = 'handshake'
    let settled = false
    const finish = (error) => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      if (error) {
        child.kill()
        reject(error)
      } else {
        resolve()
      }
    }
    const timeout = setTimeout(() => {
      finish(new Error(`Timed out during ${runtime} utility host ${phase}`))
    }, 10_000)

    child.once('error', (error) => {
      finish(error)
    })
    child.once('exit', (code) => {
      if (phase === 'crash') {
        finish()
        return
      }
      if (phase === 'shutdown' && code === 0) {
        finish()
        return
      }
      finish(
        new Error(
          `${runtime} utility host exited during ${phase} (code ${code})`,
        ),
      )
    })
    child.on('message', (message) => {
      if (!message || typeof message !== 'object') return
      if (phase === 'handshake') {
        if (message.type !== 'ready' || message.runtime !== runtime) return
        if (
          message.contractVersion !== manifest.contractVersion ||
          message.build?.commit !== manifest.commitSha ||
          message.build?.napi !== String(manifest.napiVersion) ||
          (runtime === 'media' && message.build?.livekit !== manifest.liveKitVersion) ||
          !requiredCapabilities(runtime).every((capability) =>
            message.capabilities?.includes(capability),
          )
        ) {
          finish(
            new Error(
              `${runtime} utility host returned incompatible build metadata`,
            ),
          )
          return
        }
        if (injectCrash) {
          phase = 'crash'
          child.kill()
          return
        }
        phase = 'command'
        child.postMessage({
          type: 'request',
          requestId: commandRequestId,
          command:
            runtime === 'media'
              ? { type: 'stopPreview' }
              : { type: 'stopHotkeys' },
        })
        return
      }
      if (
        phase === 'command' &&
        message.type === 'reply' &&
        message.requestId === commandRequestId
      ) {
        if (message.ok !== true) {
          finish(new Error(`${runtime} DLL rejected the smoke command`))
          return
        }
        phase = 'shutdown'
        child.postMessage({
          type: 'request',
          requestId: shutdownRequestId,
          command: { type: 'shutdown' },
        })
        return
      }
      if (
        phase === 'shutdown' &&
        message.type === 'reply' &&
        message.requestId === shutdownRequestId &&
        message.ok !== true
      ) {
        finish(new Error(`${runtime} DLL rejected graceful shutdown`))
      }
    })
  })
}

function requiredCapabilities(runtime) {
  return runtime === 'media'
    ? ['microphone', 'screen', 'screenAudio', 'preview', 'queries']
    : ['hotkeys', 'overlay']
}
