import path from 'node:path'

import { app, type BrowserWindow } from 'electron'

import { NativeMediaController } from './native-runtime/native-media-controller'
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
import { captureNativeDiagnosticIncident } from './native-runtime/diagnostic-incidents'
import { attachNativeRuntimeMetrics } from './native-runtime/anonymous-metrics'
import { NativeRtcEngineAdapter } from './voice/native-rtc-engine-adapter'
import { NativeSharedTextureBridge } from './native-video/shared-texture-bridge'

let getWindowRef: (() => BrowserWindow | null) | null = null
let remoteVideoBridge: NativeSharedTextureBridge | null = null
let localPreviewBridge: NativeSharedTextureBridge | null = null
let stopVideoEvents: (() => void) | null = null
let stopControllerEvents: (() => void) | null = null

type NativeMediaDiagnostics = {
  session: NativeDiagnosticSession
  log: NativeDiagnosticLog
}

let nativeMediaDiagnostics: NativeMediaDiagnostics | null | undefined

const diagnosticSink: DiagnosticLogSink = ({ scope, event, ...detail }) => {
  try {
    captureNativeDiagnosticIncident({ scope, event, ...detail })
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

attachNativeRuntimeMetrics(supervisor, 'media')

export type { PendingNativePicker }
export {
  clearPendingNativePicker,
  getPendingNativePicker,
  setPendingNativePicker,
}

export function getNativeMediaController() {
  return controller
}

export function createNativeRtcEngineAdapter() {
  return new NativeRtcEngineAdapter(supervisor)
}

export function logNativeVoiceDiagnostic(event: string, data?: unknown) {
  try {
    captureNativeDiagnosticIncident(nativeVoiceDiagnosticRecord(event, data))
    ensureNativeMediaDiagnostics()?.log.log(`desktop_voice.${event}`, data)
  } catch {
    // Voice diagnostics must never change control-plane or RTC behavior.
  }
}

export async function flushNativeMediaDiagnostics() {
  await ensureNativeMediaDiagnostics()?.log.flush()
}

export function registerNativeMediaRuntimeIpc(
  getWindow: () => BrowserWindow | null,
) {
  getWindowRef = getWindow
  remoteVideoBridge ??= createVideoBridge(getWindow, false)
  localPreviewBridge ??= createVideoBridge(getWindow, true)
  stopControllerEvents ??= controller.subscribe((event) => {
    if (event.type !== 'remoteVideoSessionReset') return
    remoteVideoBridge?.resetSession(event.sessionId, event.generation)
  })
  stopVideoEvents ??= supervisor.onEvent((event) => {
    if (event.type === 'localScreenPreviewFailed') {
      console.warn('[native-media] local screen preview failed', {
        sessionId: event.sessionId,
        generation: event.generation,
        trackId: event.trackId,
        code: event.error.code,
        stage: event.error.stage,
        message: event.error.message,
      })
      return
    }
    if (event.type === 'localCameraPreviewFailed') {
      console.warn('[native-media] local camera preview failed', {
        sessionId: event.sessionId,
        generation: event.generation,
        trackId: event.trackId,
        code: event.error.code,
        stage: event.error.stage,
        message: event.error.message,
      })
    }
    if (event.type === 'remoteVideoFrame' ||
      event.type === 'localScreenPreviewFrame' ||
      event.type === 'localCameraPreviewFrame') {
      const local = event.type !== 'remoteVideoFrame'
      if (!local && !controller.isCurrentVoiceSession(
        event.sessionId,
        event.generation,
      )) {
        void supervisor.request({
          type: 'releaseRemoteVideoFrame',
          sessionId: event.sessionId,
          generation: event.generation,
          trackId: event.trackId,
          sequence: event.frameSequence,
        }, 2_000).catch(() => undefined)
        return
      }
      const bridge = local ? localPreviewBridge : remoteVideoBridge
      if (!bridge) return
      void bridge.deliver({
        sessionId: event.sessionId,
        generation: event.generation,
        trackId: event.trackId,
        participantIdentity: event.participantIdentity,
        source: event.source,
        local,
        sequence: event.frameSequence,
        width: event.width,
        height: event.height,
        timestampUs: event.timestampUs,
        runtimeEpoch: supervisor.getSnapshot().restartCount,
        ntHandle: Buffer.from(event.ntHandle),
      }).then((delivered) => {
        if (!local && delivered) {
          controller.markRemoteVideoFrameDelivered(
            event.sessionId,
            event.generation,
            event.trackId,
          )
        }
      }).catch((error) => {
        diagnosticSink({
          scope: 'native-video',
          event: 'frame_delivery_rejected',
          kind: local ? 'local-preview' : 'remote-video',
          stage: 'renderer-delivery',
          generation: event.generation,
          message: safeErrorMessage(error),
        })
      })
      return
    }
    if (event.type === 'remoteScreenPublicationAvailable' ||
      event.type === 'remoteScreenPublicationUnavailable') {
      if (!controller.isCurrentVoiceSession(event.sessionId, event.generation)) return
      const window = getWindow()
      if (window && !window.isDestroyed()) {
        const suffix = event.type === 'remoteScreenPublicationAvailable'
          ? 'available'
          : 'unavailable'
        window.webContents.send(
          `syrnike-desktop:media:remote-screen-publication-${suffix}`,
          {
            trackId: event.trackId,
            participantIdentity: event.participantIdentity,
            source: event.source,
            sessionId: event.sessionId,
            generation: event.generation,
          },
        )
      }
      return
    }
    if (event.type === 'remoteVideoTrackRemoved' || event.type === 'remoteVideoFailed' ||
      event.type === 'localScreenPreviewTrackRemoved' ||
      event.type === 'localCameraPreviewTrackRemoved' ||
      event.type === 'localCameraPreviewFailed') {
      const bridge = event.type === 'localScreenPreviewTrackRemoved' ||
        event.type === 'localCameraPreviewTrackRemoved' ||
        event.type === 'localCameraPreviewFailed'
        ? localPreviewBridge
        : remoteVideoBridge
      if (bridge === remoteVideoBridge &&
        !controller.isCurrentVoiceSession(event.sessionId, event.generation)) return
      bridge?.removeTrack(event.sessionId, event.generation, event.trackId)
      const window = getWindow()
      if (window && !window.isDestroyed()) {
        window.webContents.send('syrnike-desktop:media:remote-video-track-removed', {
          trackId: event.trackId,
          sessionId: event.sessionId,
          generation: event.generation,
        })
      }
    }
  })
  const window = getWindow()
  window?.webContents.on(
    'did-start-navigation',
    (_event, _url, isInPlace, isMainFrame) => {
      if (isRendererReplacementNavigation(isInPlace, isMainFrame)) {
        rendererReloaded()
      }
    },
  )
  window?.webContents.on('render-process-gone', (_event, details) => {
    console.error('[native-video] renderer process gone', details)
    rendererReloaded()
  })
  registerNativeMediaIpc(getWindow, controller)
}

function createVideoBridge(
  getWindow: () => BrowserWindow | null,
  local: boolean,
) {
  return new NativeSharedTextureBridge({
    getWindow,
    release: async (frame) => {
      const runtime = supervisor.getSnapshot()
      if (runtime.status !== 'ready' || runtime.restartCount !== frame.runtimeEpoch) return
      const identity = {
        sessionId: frame.sessionId,
        generation: frame.generation,
        trackId: frame.trackId,
        sequence: frame.sequence,
      }
      const command = local
        ? frame.source === 'camera'
          ? { type: 'releaseLocalCameraPreviewFrame' as const, ...identity }
          : { type: 'releaseLocalScreenPreviewFrame' as const, ...identity }
        : { type: 'releaseRemoteVideoFrame' as const, ...identity }
      await supervisor.request(command, 2_000)
    },
    onTrackStalled: local
      ? undefined
      : async (frame) => {
          await controller.recoverRemoteVideoDemand(
            frame.sessionId,
            frame.generation,
            frame.trackId,
          )
        },
  })
}

function rendererReloaded() {
  controller.resetRemoteVideoDemands()
  remoteVideoBridge?.rendererReloaded()
  localPreviewBridge?.rendererReloaded()
}

export function isRendererReplacementNavigation(
  isInPlace: boolean,
  isMainFrame: boolean,
) {
  return isMainFrame && !isInPlace
}

export function startNativeMediaRuntime() {
  const diagnostics = ensureNativeMediaDiagnostics()
  diagnostics?.log.log('native_media_bootstrap_requested', {
    packaged: app.isPackaged,
    appVersion: app.getVersion(),
  })
  void controller
    .start()
    .catch((error) => {
      diagnosticSink({
        scope: 'native-media-controller',
        event: 'bootstrap_failed',
        message: safeErrorMessage(error),
      })
    })
}

export async function disposeNativeMediaRuntime() {
  const diagnostics = nativeMediaDiagnostics ?? null
  diagnostics?.log.log('native_media_dispose_requested')
  try {
    stopVideoEvents?.()
    stopVideoEvents = null
    stopControllerEvents?.()
    stopControllerEvents = null
    remoteVideoBridge?.dispose()
    remoteVideoBridge = null
    localPreviewBridge?.dispose()
    localPreviewBridge = null
    await controller.dispose()
    diagnostics?.log.log('native_media_dispose_completed')
  } catch (error) {
    diagnosticSink({
      scope: 'native-media-controller',
      event: 'dispose_failed',
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

function nativeVoiceDiagnosticRecord(
  event: string,
  data: unknown,
): Parameters<DiagnosticLogSink>[0] {
  const detail = isRecord(data) ? data : {}
  const failure = isRecord(detail.failure) ? detail.failure : {}
  return {
    scope: 'desktop-voice',
    event,
    status: diagnosticString(
      detail.status ?? detail.connection ?? detail.eventType,
    ),
    reason: diagnosticString(detail.reason),
    stage: diagnosticString(detail.stage ?? failure.stage),
    errorCode: diagnosticString(
      detail.errorCode ?? detail.errorType ?? failure.code,
    ),
    message: diagnosticString(
      detail.errorMessage ?? detail.message ?? failure.message,
    ),
  }
}

function diagnosticString(value: unknown) {
  return typeof value === 'string' && value.length > 0
    ? value.slice(0, 4_096)
    : undefined
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function ensureNativeMediaDiagnostics(): NativeMediaDiagnostics | null {
  // DesktopVoiceService publishes its initial snapshot during module loading,
  // before Electron paths are available. Do not cache that early attempt as a
  // permanent diagnostics failure for the rest of the process lifetime.
  if (!app.isReady()) return null
  if (nativeMediaDiagnostics !== undefined) return nativeMediaDiagnostics
  if (
    process.platform !== 'win32' ||
    process.env.SYRNIKE_NATIVE_MEDIA_DIAGNOSTICS !== '1'
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
