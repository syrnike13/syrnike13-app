const fs = require('node:fs')
const path = require('node:path')
const { spawn } = require('node:child_process')
const { app, utilityProcess } = require('electron')

const DEFAULT_TIMEOUT_MS = 10_000

function createSmokeContext(overrides = {}) {
  const processEnv = overrides.processEnv ?? process.env
  const repoRoot =
    overrides.repoRoot ?? path.resolve(__dirname, '..', '..', '..')
  const utilityRoot =
    overrides.utilityRoot ??
    path.resolve(repoRoot, 'apps', 'desktop', 'out', 'utility')
  const nativeRoot =
    overrides.nativeRoot ??
    path.resolve(repoRoot, 'apps', 'desktop', 'out', 'native', 'win32-x64')
  const manifest =
    overrides.manifest ??
    require(path.resolve(nativeRoot, 'native-manifest.json'))
  const diagnosticRoot =
    overrides.diagnosticRoot ?? processEnv.SYRNIKE_NATIVE_DIAGNOSTIC_ROOT_DIR
  const diagnosticRunId =
    overrides.diagnosticRunId ??
    processEnv.SYRNIKE_NATIVE_DIAGNOSTIC_RUN_ID ??
    `utility-smoke-${process.pid}`
  const diagnosticPaths =
    overrides.diagnosticPaths ??
    (diagnosticRoot
      ? {
          utility: path.resolve(diagnosticRoot, 'utility.jsonl'),
          native: path.resolve(diagnosticRoot, 'native.jsonl'),
        }
      : null)

  if (diagnosticRoot) {
    (overrides.fs ?? fs).mkdirSync(diagnosticRoot, { recursive: true })
  }

  return {
    fs: overrides.fs ?? fs,
    path: overrides.path ?? path,
    app: overrides.app ?? app,
    utilityProcess: overrides.utilityProcess ?? utilityProcess,
    manifest,
    repoRoot,
    utilityRoot,
    nativeRoot,
    diagnosticRoot,
    diagnosticRunId,
    diagnosticPaths,
    utilityEnvironment:
      overrides.utilityEnvironment ??
      Object.fromEntries(
        [
          'APPDATA',
          'LOCALAPPDATA',
          'SystemRoot',
          'TEMP',
          'TMP',
          'USERPROFILE',
          'WINDIR',
        ].flatMap((key) => (processEnv[key] ? [[key, processEnv[key]]] : [])),
      ),
    timeoutMs: overrides.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    setTimeoutFn: overrides.setTimeoutFn ?? setTimeout,
    clearTimeoutFn: overrides.clearTimeoutFn ?? clearTimeout,
    observe: overrides.observe ?? null,
  }
}

async function runSmokeSuite(context) {
  await smokeMediaEventSerialization(context)
  await smokeRuntime(context, 'media', 'media-host.cjs', 'syrnike_media.node')
  await smokeRuntime(context, 'hotkey', 'hotkey-host.cjs', 'syrnike_hotkey.node')
  await smokeRuntime(context, 'overlay', 'overlay-host.cjs', 'syrnike_overlay.node')
  await smokeRuntime(
    context,
    'media',
    'media-host.cjs',
    'syrnike_media.node',
    true,
  )
  verifyDiagnostics(context)
}

async function smokeMediaEventSerialization(context) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [context.path.resolve(__dirname, 'smoke-media-event-host.cjs')],
      {
        stdio: ['ignore', 'pipe', 'ignore'],
        env: {
          ...process.env,
          SYRNIKE_NATIVE_MODULE_PATH: context.path.resolve(
            context.nativeRoot,
            'syrnike_media.node',
          ),
        },
      },
    )
    let settled = false
    const finish = (error) => {
      if (settled) return
      settled = true
      context.clearTimeoutFn(timeout)
      child.kill()
      if (error) {
        reject(error)
      } else {
        resolve()
      }
    }
    const timeout = context.setTimeoutFn(
      () => finish(new Error('Timed out waiting for local preview removal event')),
      context.timeoutMs,
    )
    child.once('error', finish)
    child.once('exit', (code) => {
      finish(new Error(`Media event serialization smoke exited with code ${code}`))
    })
    child.stdout.on('data', (chunk) => {
      if (chunk.toString().includes('local-preview-removal-source-ok')) finish()
    })
  })
}

function smokeRuntime(context, runtime, hostName, addonName, injectCrash = false) {
  return new Promise((resolve, reject) => {
    const child = context.utilityProcess.fork(
      context.path.resolve(context.utilityRoot, hostName),
      [],
      {
        serviceName: `syrnike-${runtime}-smoke`,
        stdio: 'ignore',
        env: buildChildEnvironment(context, runtime, addonName),
      },
    )
    const commandRequestId = `${runtime}-smoke-command`
    const shutdownRequestId = `${runtime}-smoke-shutdown`
    const observationLog = []
    let phase = 'handshake'
    let settled = false

    observe(context, observationLog, {
      direction: 'host',
      event: 'fork',
      runtime,
      hostName,
      serviceName: `syrnike-${runtime}-smoke`,
    })

    const finish = (error) => {
      if (settled) return
      settled = true
      context.clearTimeoutFn(timeout)
      if (error) {
        child.kill()
        reject(attachObservation(error, observationLog))
        return
      }
      resolve()
    }
    const timeout = context.setTimeoutFn(() => {
      finish(new Error(`Timed out during ${runtime} utility host ${phase}`))
    }, context.timeoutMs)

    child.once('error', (error) => {
      observe(context, observationLog, {
        direction: 'child',
        event: 'error',
        runtime,
        phase,
        detail: describeError(error),
      })
      finish(error)
    })
    child.once('exit', (code) => {
      observe(context, observationLog, {
        direction: 'child',
        event: 'exit',
        runtime,
        phase,
        code,
      })
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
      observe(context, observationLog, {
        direction: 'child',
        event: 'message',
        runtime,
        phase,
        detail: describeMessage(message),
      })
      if (!message || typeof message !== 'object') return
      if (phase === 'handshake') {
        if (message.type !== 'ready' || message.runtime !== runtime) return
        if (
          message.contractVersion !== context.manifest.contractVersion ||
          message.build?.commit !== context.manifest.commitSha ||
          message.build?.napi !== String(context.manifest.napiVersion) ||
          (runtime === 'media' &&
            message.build?.livekit !== context.manifest.liveKitVersion) ||
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
        postMessage(context, child, observationLog, runtime, phase, {
          type: 'request',
          requestId: commandRequestId,
          command:
            runtime === 'media'
              ? { type: 'stopPreview' }
              : runtime === 'hotkey'
                ? { type: 'stopHotkeys' }
                : { type: 'stopOverlay' },
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
        postMessage(context, child, observationLog, runtime, phase, {
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

function buildChildEnvironment(context, runtime, addonName) {
  return {
    ...context.utilityEnvironment,
    SYRNIKE_NATIVE_ROOT: context.nativeRoot,
    SYRNIKE_NATIVE_RUNTIME_KIND: runtime,
    SYRNIKE_NATIVE_MODULE_PATH: context.path.resolve(context.nativeRoot, addonName),
    SYRNIKE_NATIVE_APP_VERSION: context.manifest.appVersion,
    SYRNIKE_NATIVE_RELEASE_CHANNEL: context.manifest.releaseChannel,
    SYRNIKE_NATIVE_CONTRACT_VERSION: String(context.manifest.contractVersion),
    SYRNIKE_NATIVE_LIVEKIT_VERSION: context.manifest.liveKitVersion,
    SYRNIKE_NATIVE_COMMIT_SHA: context.manifest.commitSha,
    ...(runtime === 'media' && context.diagnosticPaths
      ? {
          SYRNIKE_NATIVE_DIAGNOSTIC_RUN_ID: context.diagnosticRunId,
          SYRNIKE_NATIVE_UTILITY_LOG_PATH: context.diagnosticPaths.utility,
          SYRNIKE_NATIVE_MEDIA_LOG_PATH: context.diagnosticPaths.native,
        }
      : {}),
  }
}

function verifyDiagnostics(context) {
  if (!context.diagnosticPaths) return
  for (const [role, filePath] of Object.entries(context.diagnosticPaths)) {
    if (!context.fs.statSync(filePath).isFile()) {
      throw new Error(`${role} diagnostic file was not created at the exact path`)
    }
    const records = context.fs.readFileSync(filePath, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line))
    if (records.length === 0) {
      throw new Error(`${role} diagnostic file is empty`)
    }
    if (records.some((record) => record.runId !== context.diagnosticRunId)) {
      throw new Error(`${role} diagnostic file lost the shared run id`)
    }
  }
}

function observe(context, observationLog, entry) {
  observationLog.push(entry)
  context.observe?.(entry)
}

function postMessage(context, child, observationLog, runtime, phase, message) {
  observe(context, observationLog, {
    direction: 'host',
    event: 'postMessage',
    runtime,
    phase,
    detail: describeMessage(message),
  })
  child.postMessage(message)
}

function attachObservation(error, observationLog) {
  if (!observationLog.length) return error
  error.message = `${error.message}; observed ${formatObservationLog(observationLog)}`
  return error
}

function formatObservationLog(observationLog) {
  return observationLog.map(formatObservationEntry).join(' -> ')
}

function formatObservationEntry(entry) {
  const segments = [entry.direction, entry.event]
  if (entry.runtime) segments.push(entry.runtime)
  if (entry.phase) segments.push(entry.phase)
  if (entry.code !== undefined) segments.push(`code=${entry.code}`)
  if (entry.serviceName) segments.push(entry.serviceName)
  if (entry.detail) segments.push(entry.detail)
  return segments.join(':')
}

function describeMessage(message) {
  if (!message || typeof message !== 'object') return typeof message
  const segments = []
  if (typeof message.type === 'string') segments.push(message.type)
  if (typeof message.runtime === 'string') segments.push(`runtime=${message.runtime}`)
  if (typeof message.requestId === 'string') segments.push(`request=${message.requestId}`)
  if (message.ok === true) segments.push('ok')
  if (message.ok === false) segments.push('error')
  if (message.command?.type) segments.push(`command=${message.command.type}`)
  if (message.control?.type) segments.push(`control=${message.control.type}`)
  return segments.join(',')
}

function describeError(error) {
  if (!(error instanceof Error)) return typeof error
  return error.name === 'Error' ? error.message : `${error.name}:${error.message}`
}

function requiredCapabilities(runtime) {
  if (runtime === 'media') return [
    'microphone',
    'screen',
    'screenAudio',
    'preview',
    'queries',
    'remoteVideo',
    'localScreenPreview',
  ]
  return runtime === 'hotkey' ? ['hotkeys'] : ['overlay']
}

if (process.versions.electron && process.type === 'browser') {
  const context = createSmokeContext()
  context.app.disableHardwareAcceleration()
  const readyTimeout = setTimeout(() => {
    console.error('[desktop-native] Electron app readiness timed out')
    context.app.exit(1)
  }, DEFAULT_TIMEOUT_MS)
  context.app.whenReady().then(async () => {
    clearTimeout(readyTimeout)
    try {
      await runSmokeSuite(context)
      console.info('[desktop-native] Electron utility-process smoke passed')
      context.app.exit(0)
    } catch (error) {
      console.error(error)
      context.app.exit(1)
    }
  })
}

module.exports = {
  DEFAULT_TIMEOUT_MS,
  attachObservation,
  buildChildEnvironment,
  createSmokeContext,
  formatObservationLog,
  requiredCapabilities,
  runSmokeSuite,
  smokeRuntime,
  verifyDiagnostics,
}
