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
    spawn: overrides.spawn ?? spawn,
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
    NativeRuntimeSupervisor: overrides.NativeRuntimeSupervisor ?? null,
    audioPolicySmokeEnabled:
      overrides.audioPolicySmokeEnabled ??
      (processEnv.SYRNIKE_WINDOWS_AUDIO_POLICY_SMOKE === '1' ||
        process.argv.includes('--audio-policy')),
  }
}

async function runSmokeSuite(context) {
  if (context.audioPolicySmokeEnabled) {
    const report = await smokeWindowsAudioPolicyRuntime(context)
    console.info(
      `[desktop-native] windows audio policy smoke ${JSON.stringify(report)}`,
    )
  }
  await smokeMediaEventSerialization(context)
  await smokeNodeEventSink(context)
  await smokeActiveCallShutdown(context)
  await smokeNativeQuarantineShutdown(context)
  await smokeDroppedObjectWrap(context)
  await smokeAsyncCleanupLaunchFailure(
    context,
    'syrnike_media.node',
    'createMediaRuntime',
  )
  await smokeAsyncCleanupLaunchFailure(
    context,
    'syrnike_hotkey.node',
    'createHotkeyRuntime',
  )
  await smokeAsyncCleanupDispatchFailure(
    context,
    'syrnike_media.node',
    'createMediaRuntime',
  )
  await smokeAsyncCleanupDispatchFailure(
    context,
    'syrnike_hotkey.node',
    'createHotkeyRuntime',
  )
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

async function smokeAsyncCleanupLaunchFailure(
  context,
  addonName,
  factoryName,
) {
  return smokeAsyncCleanupFailure(
    context,
    addonName,
    factoryName,
    'SYRNIKE_NATIVE_FAIL_ASYNC_CLEANUP_LAUNCH_ONCE',
    'async cleanup retry',
  )
}

async function smokeAsyncCleanupDispatchFailure(
  context,
  addonName,
  factoryName,
) {
  return smokeAsyncCleanupFailure(
    context,
    addonName,
    factoryName,
    'SYRNIKE_NATIVE_FAIL_ASYNC_CLEANUP_DISPATCH_ONCE',
    'post-init async cleanup fallback',
  )
}

async function smokeAsyncCleanupFailure(
  context,
  addonName,
  factoryName,
  injectionName,
  description,
) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [
        context.path.resolve(
          __dirname,
          'smoke-async-cleanup-launch-failure-host.cjs',
        ),
      ],
      {
        stdio: ['ignore', 'pipe', 'pipe'],
        env: {
          ...process.env,
          SYRNIKE_NATIVE_FAIL_ASYNC_CLEANUP_LAUNCH_ONCE: '0',
          SYRNIKE_NATIVE_FAIL_ASYNC_CLEANUP_DISPATCH_ONCE: '0',
          [injectionName]: '1',
          SYRNIKE_NATIVE_MODULE_PATH: context.path.resolve(
            context.nativeRoot,
            addonName,
          ),
          SYRNIKE_NATIVE_RUNTIME_FACTORY: factoryName,
        },
      },
    )
    let armed = false
    let settled = false
    let stderr = ''
    const finish = (error) => {
      if (settled) return
      settled = true
      context.clearTimeoutFn(timeout)
      child.kill()
      if (error) reject(error)
      else resolve()
    }
    const timeout = context.setTimeoutFn(
      () => finish(new Error(
        `Timed out waiting for ${description}: ${addonName}`,
      )),
      5_000,
    )
    child.once('error', finish)
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString()
    })
    child.stdout.on('data', (chunk) => {
      if (chunk.toString().includes('async-cleanup-launch-failure-armed')) {
        armed = true
      }
    })
    child.once('exit', (code) => {
      if (code === 0 && armed) {
        finish()
      } else {
        finish(new Error(
          `${description} smoke exited with code ${code}: ${stderr.trim()}`,
        ))
      }
    })
  })
}

async function smokeActiveCallShutdown(context) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [context.path.resolve(__dirname, 'smoke-active-call-shutdown-host.cjs')],
      {
        stdio: ['ignore', 'pipe', 'pipe'],
        env: {
          ...process.env,
          SYRNIKE_UTILITY_ROOT: context.utilityRoot,
        },
      },
    )
    let settled = false
    let stderr = ''
    const finish = (error) => {
      if (settled) return
      settled = true
      context.clearTimeoutFn(timeout)
      child.kill()
      if (error) reject(error)
      else resolve()
    }
    const timeout = context.setTimeoutFn(
      () => finish(new Error('Timed out waiting for active-call shutdown smoke')),
      5_000,
    )
    child.once('error', finish)
    child.once('exit', (code) => {
      if (code === 0) {
        finish()
      } else {
        finish(new Error(
          `Active-call shutdown smoke exited with code ${code}: ${stderr.trim()}`,
        ))
      }
    })
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString()
    })
    child.stdout.on('data', (chunk) => {
      if (chunk.toString().includes('active-call-shutdown-budget-ok')) finish()
    })
  })
}

async function smokeNodeEventSink(context) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [context.path.resolve(__dirname, 'smoke-node-event-sink-host.cjs')],
      {
        stdio: ['ignore', 'pipe', 'pipe'],
        env: {
          ...process.env,
          SYRNIKE_NATIVE_SMOKE_TEST_MODE: '1',
          SYRNIKE_NATIVE_CONTROL_EVENT_CAPACITY: '64',
          ...(context.diagnosticPaths
            ? {
                SYRNIKE_NATIVE_DIAGNOSTIC_RUN_ID: context.diagnosticRunId,
                SYRNIKE_NATIVE_MEDIA_LOG_PATH: context.diagnosticPaths.native,
              }
            : {}),
          SYRNIKE_NATIVE_MODULE_PATH: context.path.resolve(
            context.nativeRoot,
            'syrnike_media.node',
          ),
        },
      },
    )
    let settled = false
    let stderr = ''
    const finish = (error) => {
      if (settled) return
      settled = true
      context.clearTimeoutFn(timeout)
      child.kill()
      if (error) reject(error)
      else resolve()
    }
    const timeout = context.setTimeoutFn(
      () => finish(new Error('Timed out waiting for Node event sink smoke')),
      context.timeoutMs,
    )
    child.once('error', finish)
    let passed = false
    child.once('exit', (code) => {
      if (code === 0 && passed) {
        finish()
      } else {
        finish(new Error(
          `Node event sink smoke exited with code ${code}: ${stderr.trim()}`,
        ))
      }
    })
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString()
    })
    child.stdout.on('data', (chunk) => {
      if (chunk.toString().includes('node-event-listener-and-backpressure-ok')) {
        passed = true
      }
    })
  })
}

async function smokeNativeQuarantineShutdown(context) {
  return new Promise((resolve, reject) => {
    const child = context.spawn(
      process.execPath,
      [context.path.resolve(
        __dirname,
        'smoke-quarantine-shutdown-host.cjs',
      )],
      {
        stdio: ['ignore', 'pipe', 'pipe'],
        env: {
          ...process.env,
          SYRNIKE_NATIVE_MODULE_PATH: context.path.resolve(
            context.nativeRoot,
            'syrnike_media.node',
          ),
          SYRNIKE_NATIVE_BLOCK_MICROPHONE_OPERATION_ONCE: '1',
          SYRNIKE_NATIVE_FAIL_MEDIA_QUARANTINE_LAUNCH_ONCE: '1',
          SYRNIKE_NATIVE_OBSERVE_MEDIA_QUARANTINE_CLEANUP: '1',
        },
      },
    )
    let settled = false
    let stdout = ''
    let stderr = ''
    const finish = (error) => {
      if (settled) return
      settled = true
      context.clearTimeoutFn(timeout)
      if (error) {
        child.kill()
        reject(error)
      } else {
        resolve()
      }
    }
    const timeout = context.setTimeoutFn(
      () => finish(new Error('Timed out waiting for native quarantine smoke')),
      context.timeoutMs,
    )
    child.once('error', finish)
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString()
    })
    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString()
    })
    child.once('close', (code) => {
      if (
        code === 0 &&
        stdout.includes('native-quarantine-launch-retry-ok')
      ) {
        finish()
      } else {
        finish(new Error(
          `Native quarantine smoke closed with code ${code}: ${stderr.trim()}`,
        ))
      }
    })
  })
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

async function smokeDroppedObjectWrap(context) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [
        '--js-flags=--expose-gc',
        context.path.resolve(__dirname, 'smoke-dropped-objectwrap-host.cjs'),
      ],
      {
        stdio: ['ignore', 'pipe', 'pipe'],
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
    let stderr = ''
    const finish = (error) => {
      if (settled) return
      settled = true
      context.clearTimeoutFn(timeout)
      child.kill()
      if (error) reject(error)
      else resolve()
    }
    const timeout = context.setTimeoutFn(
      () => finish(new Error('Timed out waiting for dropped ObjectWrap smoke')),
      context.timeoutMs,
    )
    child.once('error', finish)
    child.once('exit', (code) => {
      finish(new Error(
        `Dropped ObjectWrap smoke exited with code ${code}: ${stderr.trim()}`,
      ))
    })
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString()
    })
    child.stdout.on('data', (chunk) => {
      if (chunk.toString().includes('dropped-objectwrap-immediate-recreate-ok')) {
        finish()
      }
    })
  })
}

async function smokeWindowsAudioPolicyRuntime(context) {
  // warmMicrophone is the only production audio command that can create a
  // session without external LiveKit credentials or a real display source.
  // Remote render and screen loopback therefore use the native production
  // attempt seam tests; this child smoke proves real addon dispatch, concrete
  // device selection, and host-epoch recreation without inventing credentials.
  const observationLog = []
  let phase = 'handshake'
  let activeAdapter = null
  const Supervisor =
    context.NativeRuntimeSupervisor ??
    require(
      context.path.resolve(context.utilityRoot, 'runtime-supervisor.cjs'),
    ).NativeRuntimeSupervisor
  const supervisor = new Supervisor({
    runtime: 'media',
    handshakeTimeoutMs: context.timeoutMs,
    schedule: context.setTimeoutFn,
    createAdapter: () => {
      const adapter = createSmokeAdapter(
        context,
        observationLog,
        'media',
        'media-host.cjs',
        'syrnike_media.node',
        () => phase,
      )
      activeAdapter = adapter
      return adapter
    },
  })
  const report = {
    status: 'passed',
    reasonCode: 'audio_policy_utility_epoch_passed',
    defaultAttempted: false,
    explicitAttempted: false,
    restartCount: 0,
    bluetooth: 'present',
    blockers: [],
  }
  try {
    validateReady(context, 'media', await supervisor.start())
    phase = 'list_default_epoch'
    const devices = await supervisor.request(
      { type: 'listDevices', kind: 'audioinput' },
      context.timeoutMs,
      { probeOnTimeout: false },
    )
    const concreteDevices = Array.isArray(devices)
      ? devices.filter(
          (device) =>
            device &&
            typeof device.deviceId === 'string' &&
            device.deviceId !== 'default',
        )
      : []
    report.bluetooth = concreteDevices.some((device) =>
      /bluetooth|hands[- ]?free|headset/i.test(String(device.label)),
    )
      ? 'present'
      : 'blocked_absent'
    if (report.bluetooth === 'blocked_absent') {
      report.blockers.push('bluetooth_communications_endpoint_absent')
    }

    phase = 'warm_default'
    report.defaultAttempted = true
    await supervisor.request(
      microphoneWarmCommand(null, 1),
      context.timeoutMs,
      { probeOnTimeout: false },
    )

    phase = 'restart'
    const recovered = waitForSupervisorState(
      supervisor,
      (snapshot) => snapshot.status === 'ready' && snapshot.restartCount > 0,
    )
    activeAdapter?.kill()
    await recovered
    report.restartCount = supervisor.getSnapshot().restartCount

    if (concreteDevices.length === 0) {
      report.status = 'unsupported'
      report.reasonCode = 'audio_input_explicit_device_absent'
      report.blockers.push(report.reasonCode)
      return report
    }
    phase = 'warm_explicit'
    report.explicitAttempted = true
    await supervisor.request(
      microphoneWarmCommand(concreteDevices[0].deviceId, 2),
      context.timeoutMs,
      { probeOnTimeout: false },
    )
    return report
  } catch (error) {
    report.status = 'failed'
    report.reasonCode = nativeSmokeFailureCode(error)
    throw attachObservation(
      new Error(
        `Windows audio policy utility smoke failed (${report.reasonCode})`,
      ),
      observationLog,
    )
  } finally {
    phase = 'shutdown'
    await supervisor.shutdown().catch(() => {})
  }
}

function microphoneWarmCommand(deviceId, generation) {
  return {
    type: 'warmMicrophone',
    generation,
    config: {
      deviceId,
      bypassSystemAudioInputProcessing: true,
      automaticGainControl: true,
      noiseSuppression: true,
      echoCancellation: true,
      inputVolume: 1,
      voiceGateEnabled: false,
      voiceGateThresholdDb: -45,
      voiceGateAutoThreshold: false,
    },
  }
}

function nativeSmokeFailureCode(error) {
  if (error && typeof error === 'object') {
    if (typeof error.detail?.code === 'string') return error.detail.code
    if (typeof error.code === 'string') return error.code
  }
  return 'audio_policy_utility_unknown_failure'
}

function smokeRuntime(context, runtime, hostName, addonName, injectCrash = false) {
  const observationLog = []
  let phase = 'handshake'
  let activeAdapter = null
  let timeout = null
  let settled = false
  const Supervisor =
    context.NativeRuntimeSupervisor ??
    require(
      context.path.resolve(context.utilityRoot, 'runtime-supervisor.cjs'),
    ).NativeRuntimeSupervisor
  const supervisor = new Supervisor({
    runtime,
    handshakeTimeoutMs: context.timeoutMs,
    schedule: context.setTimeoutFn,
    createAdapter: () => {
      const adapter = createSmokeAdapter(
        context,
        observationLog,
        runtime,
        hostName,
        addonName,
        () => phase,
      )
      activeAdapter = adapter
      return adapter
    },
  })
  supervisor.onStateChange((snapshot) => {
    observe(context, observationLog, {
      direction: 'supervisor',
      event: 'state',
      runtime,
      phase,
      detail: `${snapshot.status},restart=${snapshot.restartCount},epoch=${snapshot.hostEpoch ?? 'none'}`,
    })
  })

  const operation = (async () => {
    const initialReady = await supervisor.start()
    validateReady(context, runtime, initialReady)

    if (injectCrash) {
      phase = 'crash'
      const recovered = waitForSupervisorState(
        supervisor,
        (snapshot) =>
          snapshot.status === 'ready' &&
          snapshot.restartCount > 0 &&
          snapshot.hostEpoch !== undefined,
      )
      activeAdapter?.kill()
      phase = 'restart_handshake'
      await recovered
      const restartedReady = supervisor.getSnapshot().ready
      validateReady(context, runtime, restartedReady)
    }

    phase = 'command'
    await supervisor.request(
      runtime === 'media'
        ? { type: 'stopPreview' }
        : runtime === 'hotkey'
          ? { type: 'stopHotkeys' }
          : { type: 'stopOverlay' },
      context.timeoutMs,
      { probeOnTimeout: false },
    )

    phase = 'shutdown'
    await supervisor.shutdown()
  })()

  return new Promise((resolve, reject) => {
    const finish = (error) => {
      if (settled) return
      settled = true
      if (timeout) context.clearTimeoutFn(timeout)
      if (error) {
        activeAdapter?.kill()
        reject(attachObservation(error, observationLog))
      } else {
        resolve()
      }
    }

    timeout = context.setTimeoutFn(() => {
      finish(new Error(`Timed out during ${runtime} utility host ${phase}`))
    }, context.timeoutMs)
    operation.then(
      () => finish(),
      (error) => {
        const message =
          error instanceof Error ? error.message : `${runtime} utility host failed`
        const smokeError =
          phase === 'command'
            ? new Error(`${runtime} DLL rejected the smoke command: ${message}`)
            : error instanceof Error
              ? error
              : new Error(message)
        finish(smokeError)
      },
    )
  })
}

function createSmokeAdapter(
  context,
  observationLog,
  runtime,
  hostName,
  addonName,
  currentPhase,
) {
  let child = null
  let callbacks = null
  return {
    get pid() {
      return child?.pid
    },
    start(nextCallbacks) {
      callbacks = nextCallbacks
      child = context.utilityProcess.fork(
        context.path.resolve(context.utilityRoot, hostName),
        [],
        {
          serviceName: `syrnike-${runtime}-smoke`,
          stdio: 'ignore',
          env: buildChildEnvironment(context, runtime, addonName),
        },
      )
      observe(context, observationLog, {
        direction: 'host',
        event: 'fork',
        runtime,
        hostName,
        phase: currentPhase(),
        serviceName: `syrnike-${runtime}-smoke`,
      })
      child.once('error', (error) => {
        observe(context, observationLog, {
          direction: 'child',
          event: 'error',
          runtime,
          phase: currentPhase(),
          detail: describeError(error),
        })
        callbacks?.onExit({ code: null, error })
      })
      child.once('exit', (code) => {
        observe(context, observationLog, {
          direction: 'child',
          event: 'exit',
          runtime,
          phase: currentPhase(),
          code,
        })
        callbacks?.onExit({ code })
      })
      child.on('message', (message) => {
        observe(context, observationLog, {
          direction: 'child',
          event: 'message',
          runtime,
          phase: currentPhase(),
          detail: describeMessage(message),
        })
        callbacks?.onMessage(message)
      })
    },
    postMessage(message) {
      postMessage(
        context,
        child,
        observationLog,
        runtime,
        currentPhase(),
        message,
      )
    },
    kill() {
      child?.kill()
    },
  }
}

function waitForSupervisorState(supervisor, predicate) {
  const current = supervisor.getSnapshot()
  if (predicate(current)) return Promise.resolve(current)
  return new Promise((resolve) => {
    const unsubscribe = supervisor.onStateChange((snapshot) => {
      if (!predicate(snapshot)) return
      unsubscribe()
      resolve(snapshot)
    })
  })
}

function validateReady(context, runtime, message) {
  if (
    !message ||
    message.type !== 'ready' ||
    message.runtime !== runtime ||
    message.contractVersion !== context.manifest.contractVersion ||
    message.build?.commit !== context.manifest.commitSha ||
    message.build?.napi !== String(context.manifest.napiVersion) ||
    (runtime === 'media' &&
      message.build?.livekit !== context.manifest.liveKitVersion) ||
    !requiredCapabilities(runtime).every((capability) =>
      message.capabilities?.includes(capability),
    )
  ) {
    throw new Error(
      `${runtime} utility host returned incompatible build metadata`,
    )
  }
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
  const nativeRecords = context.fs.readFileSync(
    context.diagnosticPaths.native,
    'utf8',
  )
  if (!nativeRecords.includes('"event":"native_event_listener_exception"')) {
    throw new Error('Native diagnostics omitted the injected JS listener failure')
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
    'localCameraPreview',
    'directRemoteAudio',
    'voiceControl',
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
  smokeActiveCallShutdown,
  smokeNativeQuarantineShutdown,
  smokeAsyncCleanupLaunchFailure,
  smokeAsyncCleanupDispatchFailure,
  smokeNodeEventSink,
  smokeRuntime,
  smokeWindowsAudioPolicyRuntime,
  verifyDiagnostics,
}
