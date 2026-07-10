import path from 'node:path'

import { app, type BrowserWindow } from 'electron'

import { NativeMediaController } from './native-runtime/native-media-controller'
import {
  NativeMediaReconciler,
  createNativeMediaControllerExecutionAdapter,
} from './native-runtime/native-media-reconciler'
import {
  clearPendingNativePicker,
  getPendingNativePicker,
  registerNativeMediaIpc,
  setPendingNativePicker,
  type PendingNativePicker,
} from './native-runtime/media-ipc'
import { NativeRuntimeSupervisor } from './native-runtime/runtime-supervisor'
import {
  createElectronUtilityAdapterFactory,
  nativeRuntimeAvailable,
} from './native-runtime/utility-adapter'
import {
  createNativeDiagnosticLog,
  createNativeDiagnosticSession,
  pruneNativeDiagnosticSessions,
  type DiagnosticLogSink,
  type NativeDiagnosticLog,
  type NativeDiagnosticSession,
} from './native-runtime/diagnostic-log'
import {
  attachNativeMediaSessionMetrics,
  attachNativeRuntimeMetrics,
} from './native-runtime/anonymous-metrics'

let getWindowRef: (() => BrowserWindow | null) | null = null

type NativeMediaDiagnostics = {
  session: NativeDiagnosticSession
  log: NativeDiagnosticLog
}

let nativeMediaDiagnostics: NativeMediaDiagnostics | null | undefined

const diagnosticSink: DiagnosticLogSink = ({ scope, event, ...detail }) => {
  try {
    ensureNativeMediaDiagnostics()?.log.log(`${scope}.${event}`, {
      scope,
      ...detail,
    })
  } catch {
    // Diagnostics must never change media runtime behavior.
  }
}

const supervisor = new NativeRuntimeSupervisor({
  runtime: 'media',
  createAdapter: () => {
    const diagnostics = ensureNativeMediaDiagnostics()
    return createElectronUtilityAdapterFactory('media', {
      diagnosticSession: diagnostics?.session,
      diagnosticLog: diagnostics?.log,
    })()
  },
  diagnostics: diagnosticSink,
})

const controller = new NativeMediaController({
  supervisor,
  runtimeAvailable: () => nativeRuntimeAvailable('media'),
  getSelfWindowHwnd: () => readWindowHwnd(getWindowRef?.() ?? null),
  diagnostics: diagnosticSink,
})

const reconciler = new NativeMediaReconciler({
  execution: createNativeMediaControllerExecutionAdapter(controller),
})

const stopRuntimeRecoveryObserver = supervisor.onStateChange((snapshot) => {
  if (snapshot.status === 'recovering') {
    reconciler.observeRuntimeUnavailable(snapshot.restartCount, 'recovering')
  }
  if (snapshot.status === 'degraded') {
    reconciler.observeRuntimeUnavailable(snapshot.restartCount, 'degraded')
  }
  if (snapshot.status === 'ready' && snapshot.restartCount > 0) {
    reconciler.recoverAfterRuntimeRestart(snapshot.restartCount)
  }
})

const stopExecutionTerminalObserver = controller.subscribe((event) => {
  reconciler.observeExecutionEvent(event)
})

attachNativeRuntimeMetrics(supervisor, 'media')
attachNativeMediaSessionMetrics(controller)

export type { PendingNativePicker }
export {
  clearPendingNativePicker,
  getPendingNativePicker,
  setPendingNativePicker,
}

export function getNativeMediaController() {
  return controller
}

export function registerNativeMediaRuntimeIpc(
  getWindow: () => BrowserWindow | null,
) {
  getWindowRef = getWindow
  registerNativeMediaIpc(getWindow, controller, reconciler)
}

export function startNativeMediaRuntime() {
  const diagnostics = ensureNativeMediaDiagnostics()
  diagnostics?.log.log('native_media_bootstrap_requested', {
    packaged: app.isPackaged,
    appVersion: app.getVersion(),
  })
  void controller
    .start()
    .then(() => controller.prewarmMicrophone())
    .catch((error) => {
      diagnostics?.log.log('native_media_bootstrap_failed', {
        message: safeErrorMessage(error),
      })
    })
}

export async function disposeNativeMediaRuntime() {
  const diagnostics = nativeMediaDiagnostics ?? null
  diagnostics?.log.log('native_media_dispose_requested')
  try {
    stopRuntimeRecoveryObserver()
    stopExecutionTerminalObserver()
    reconciler.dispose()
    await controller.dispose()
    diagnostics?.log.log('native_media_dispose_completed')
  } catch (error) {
    diagnostics?.log.log('native_media_dispose_failed', {
      message: safeErrorMessage(error),
    })
  } finally {
    await diagnostics?.log.close()
  }
}

export async function listNativeDisplaySources(
  getWindow?: () => BrowserWindow | null,
) {
  if (getWindow) getWindowRef = getWindow
  return controller.listDisplaySources()
}

function readWindowHwnd(win: BrowserWindow | null) {
  if (!win || win.isDestroyed()) return undefined
  const handle = win.getNativeWindowHandle()
  if (handle.length < 4) return undefined
  if (handle.length >= 8) return handle.readBigUInt64LE(0).toString()
  return handle.readUInt32LE(0).toString()
}

function safeErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : 'Native media runtime failed'
}

function ensureNativeMediaDiagnostics(): NativeMediaDiagnostics | null {
  if (nativeMediaDiagnostics !== undefined) return nativeMediaDiagnostics
  if (
    process.platform !== 'win32' ||
    (app.isPackaged && process.env.SYRNIKE_NATIVE_MEDIA_DIAGNOSTICS !== '1')
  ) {
    nativeMediaDiagnostics = null
    return null
  }

  try {
    const diagnosticRoot = path.join(
      app.getPath('userData'),
      'logs',
      'native-media-diagnostics',
    )
    void pruneNativeDiagnosticSessions(diagnosticRoot).catch(() => undefined)
    const session = createNativeDiagnosticSession({
      runtime: 'media',
      rootDir: diagnosticRoot,
    })
    const log = createNativeDiagnosticLog({
      runtime: 'media',
      role: 'electron-main',
      runId: session.runId,
      directory: session.directory,
      latestPath: session.latestPath,
      filePath: session.paths.electronMainPath,
      paths: session.paths,
    })
    nativeMediaDiagnostics = { session, log }
    log.log('diagnostic_session_started', {
      contract: 'native-media-diagnostics-v1',
      packaged: app.isPackaged,
    })
    return nativeMediaDiagnostics
  } catch {
    nativeMediaDiagnostics = null
    return null
  }
}
