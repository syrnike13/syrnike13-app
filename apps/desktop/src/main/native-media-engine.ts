import { ipcMain, type BrowserWindow, type IpcMainInvokeEvent, type WebContents } from 'electron'
import { setTimeout as delay } from 'node:timers/promises'
import {
  IPC,
  LocalScreenPreviewDemandSchema,
  type NativeMediaRuntimeState,
} from '@syrnike13/platform'
import { Effect, Schema } from 'effect'
import { createInactiveMediaPaths, mediaLifecycleError, mediaLifecycleFailure } from './media-runtime/contract'
import { MediaRuntimeSupervisor } from './media-runtime/media-runtime-supervisor'
import { createElectronMediaUtilityAdapterFactory, mediaUtilityAvailable } from './media-runtime/media-utility-adapter'
import { MediaFrameController } from './media-runtime/media-frame-controller'
import { NativeScreenPicker } from './media-runtime/native-screen-picker'
import { NativeRtcEngineAdapterV2 } from './voice/native-rtc-engine-adapter-v2'
import { decodeIpcInput } from './ipc-schema'
import {
  createNativeDiagnosticLog, createNativeDiagnosticSession,
  pruneNativeDiagnosticSessionsEffect, type NativeDiagnosticLog, type DiagnosticLogRecord,
} from './native-runtime/diagnostic-log'
import { captureNativeDiagnosticIncident, getNativeDiagnosticCorrelationId } from './native-runtime/diagnostic-incidents'

export const NATIVE_MEDIA_UNAVAILABLE_STATE: NativeMediaRuntimeState = {
  available: false,
  status: 'unavailable',
  restartCount: 0,
  hostEpoch: 0,
  paths: createInactiveMediaPaths(),
  failure: mediaLifecycleFailure('media_unavailable', 'Native media is unavailable on this device', 'native_runtime', false),
}

let registered = false
let windowGetter: () => BrowserWindow | null = () => null
let rendererListening = false
const observedRenderers = new WeakSet<WebContents>()
let diagnosticLog: NativeDiagnosticLog | null = null
let active: {
  runtime: MediaRuntimeSupervisor
  adapter: NativeRtcEngineAdapterV2
  frames: MediaFrameController
  picker: NativeScreenPicker
} | null = null

export function getNativeScreenPicker() { return active?.picker ?? null }

function runtimeState(): NativeMediaRuntimeState {
  if (!active || !mediaUtilityAvailable()) return NATIVE_MEDIA_UNAVAILABLE_STATE
  const state = active.runtime.getSnapshot()
  return {
    available: mediaUtilityAvailable(), status: state.status,
    restartCount: state.restartCount, hostEpoch: active.runtime.getHostEpoch(),
    failure: state.failure, paths: active.frames.presentationPaths(),
  }
}

function broadcastRuntimeState() {
  const window = windowGetter()
  if (window && !window.isDestroyed()) window.webContents.send(IPC.mediaRuntimeStateChanged, runtimeState())
}

function isTrustedSender(
  event: IpcMainInvokeEvent,
  getWindow: () => BrowserWindow | null,
) {
  const win = getWindow()
  return Boolean(win && !win.isDestroyed() && event.sender === win.webContents &&
    event.senderFrame && event.senderFrame === win.webContents.mainFrame)
}

function assertTrustedSender(
  event: IpcMainInvokeEvent,
  getWindow: () => BrowserWindow | null,
) {
  if (!isTrustedSender(event, getWindow)) {
    throw new Error('Untrusted native media IPC sender')
  }
  observeRenderer(event.sender)
}

function observeRenderer(contents: WebContents) {
  if (observedRenderers.has(contents)) return
  const owner = windowGetter()
  if (!owner || owner.isDestroyed() || owner.webContents !== contents) return
  observedRenderers.add(contents)
  const rendererGone = () => {
    // The destroyed event runs after BrowserWindow.webContents becomes invalid.
    // Compare the retained owner without dereferencing its native wrapper.
    if (windowGetter() !== owner) return
    rendererListening = false
    active?.frames.rendererGone()
    active?.picker.cancel()
    void active?.adapter.setMicrophonePreview(false).catch(() => logNativeVoiceDiagnostic('microphone_preview_stop_failed'))
  }
  contents.on('did-start-navigation', details => {
    if (details.isMainFrame && !details.isSameDocument) rendererGone()
  })
  contents.on('render-process-gone', rendererGone)
  contents.once('destroyed', rendererGone)
}

function unavailableError() {
  return mediaLifecycleError('media_unavailable', 'Native media is unavailable on this device', 'native_runtime', false)
}

export function createNativeRtcEngineAdapter() {
  const runtime = new MediaRuntimeSupervisor({
    createAdapter: createElectronMediaUtilityAdapterFactory(),
    onUtilityExit: evidence => {
      logNativeVoiceDiagnostic('utility_exit', {
        hostEpoch: runtime.getHostEpoch(), episodeId: runtime.getFailureEpisodeId(), ...evidence,
      })
      if (!evidence.expected) recordMediaDiagnostic({
        scope: 'native-runtime-supervisor', event: 'utility_crashed', runtime: 'media',
        hostEpoch: runtime.getHostEpoch(), episodeId: runtime.getFailureEpisodeId(),
        stage: 'utility_process', reason: evidence.source, metrics: {
          uptimeMs: evidence.uptimeMs, stderrBytes: evidence.stderrBytes,
          stderrTruncated: Number(evidence.stderrTruncated),
          ...(evidence.code === null ? {} : { exitCode: evidence.code }),
        },
      })
    },
  })
  const subscriptions: Array<() => void> = []
  const adapter = new NativeRtcEngineAdapterV2(runtime, undefined,
    failure => logNativeVoiceDiagnostic('control_failed', failure),
    () => {
      picker.dispose()
      frames.dispose()
      for (const unsubscribe of subscriptions) unsubscribe()
      if (active?.adapter === adapter) active = null
    }, mediaUtilityAvailable)
  const frames = new MediaFrameController(runtime, adapter, () => windowGetter(),
    (code, evidence) => {
      logNativeVoiceDiagnostic('frame_bridge_failed', { code, ...evidence })
      if (evidence) recordMediaDiagnostic({
        scope: 'native-video', event: 'presentation_stalled', runtime: 'media',
        errorCode: code, episodeId: evidence.episodeId, lane: evidence.path,
        hostEpoch: evidence.epoch, revision: evidence.revision,
      })
    },
    inventory => {
      const microphone = adapter.desiredSnapshot()?.microphone
      const meter = inventory.microphoneMeter
      if (!microphone || microphone.state === 'off' || !microphone.meterDemand ||
          meter.revision !== adapter.snapshot().acceptedRevision) return
      const window = windowGetter()
      if (!window || window.isDestroyed()) return
      window.webContents.send(IPC.mediaMicrophoneMetrics, {
        revision: meter.revision,
        inputDb: 20 * Math.log10(Math.max(0.00001, meter.inputLevel)),
        thresholdDb: 20 * Math.log10(Math.max(0.00001, meter.gateThreshold)),
        open: meter.gateOpen,
      })
    }, broadcastRuntimeState)
  const picker = new NativeScreenPicker(runtime, () => windowGetter())
  active = { runtime, adapter, frames, picker }
  subscriptions.push(runtime.onStateChange(broadcastRuntimeState), adapter.onSnapshot(broadcastRuntimeState))
  subscriptions.push(runtime.onStateChange(state => {
    recordMediaDiagnostic({
      scope: 'native-runtime-supervisor', event: 'state_changed', runtime: 'media',
      hostEpoch: runtime.getHostEpoch(), status: state.status, restartCount: state.restartCount,
    })
    if (state.failure) recordMediaDiagnostic({
      scope: 'native-runtime-supervisor', event: 'runtime_degraded', runtime: 'media',
      hostEpoch: runtime.getHostEpoch(), status: state.status, restartCount: state.restartCount,
      errorCode: state.failure.code, stage: state.failure.stage,
      episodeId: runtime.getFailureEpisodeId(), fatal: state.status === 'failed',
    })
  }), runtime.onEvent(event => {
    recordMediaDiagnostic({
      scope: 'native-media-controller', event: event.type, runtime: 'media',
      hostEpoch: runtime.getHostEpoch(), nativeSequence: event.sequence,
      revision: 'revision' in event ? event.revision : undefined,
      lane: 'track' in event ? event.track : undefined,
      status: 'state' in event ? event.state : 'failed',
      errorCode: event.failure?.code, stage: event.failure?.stage,
      episodeId: event.failure ? runtime.getFailureEpisodeId(event.failure.causeSequence) : undefined,
      fatal: event.type === 'fatalEngineFailure',
    })
  }), runtime.onDiagnostic(event => {
    const causeSequence = event.metrics.find(metric => metric.name === 'cause_sequence')?.value
    const episodeId = typeof causeSequence === 'number' && Number.isSafeInteger(causeSequence) && causeSequence > 0
      ? runtime.getFailureEpisodeId(causeSequence) : undefined
    // Implementation strings may contain device names or native handles. Keep
    // bounded numeric evidence and protocol codes in the product journal.
    logNativeVoiceDiagnostic('native_diagnostic', {
      hostEpoch: runtime.getHostEpoch(), nativeSequence: event.sequence,
      timestampMs: event.timestampMs, component: event.component,
      operation: event.operation, code: event.code, metrics: event.metrics,
      correlationId: episodeId ? getNativeDiagnosticCorrelationId(episodeId) : undefined,
    })
    if (event.code === 'camera_metrics')
      logNativeVoiceDiagnostic('presentation_metrics', frames.metrics())
  }))
  subscriptions.push(adapter.onSnapshot(snapshot => {
    const microphone = adapter.desiredSnapshot()?.microphone
    if (!microphone || microphone.state === 'off' || !microphone.meterDemand) return
    const window = windowGetter()
    if (!window || window.isDestroyed()) return
    const state = snapshot.tracks.microphone
    if (state.state === 'failed') window.webContents.send(IPC.mediaMicrophonePreviewState, {
      status: 'error', message: state.failure?.message ?? 'Microphone preview failed',
    })
    else if (state.state === 'running' || state.state === 'muted')
      window.webContents.send(IPC.mediaMicrophonePreviewState, { status: 'running' })
  }))
  if (rendererListening) frames.rendererReady()
  return adapter
}

export function logNativeVoiceDiagnostic(event: string, data?: unknown) {
  if (process.env.SYRNIKE_NATIVE_MEDIA_DIAGNOSTICS !== '1') return
  const rootDir = process.env.SYRNIKE_NATIVE_DIAGNOSTIC_ROOT_DIR
  if (!rootDir) return
  if (!diagnosticLog) {
    const session = createNativeDiagnosticSession({ runtime: 'media', rootDir })
    diagnosticLog = createNativeDiagnosticLog({
      ...session, role: 'electron-main', filePath: session.paths.electronMainPath,
      maxPendingWrites: 256, maxFileBytes: 4 * 1024 * 1024, maxRolledFiles: 4,
    })
    Effect.runFork(pruneNativeDiagnosticSessionsEffect(rootDir, Date.now()).pipe(Effect.ignore))
  }
  diagnosticLog.log(event, data)
}

function recordMediaDiagnostic(record: DiagnosticLogRecord) {
  const incident = captureNativeDiagnosticIncident(record)
  logNativeVoiceDiagnostic(record.event, { ...record, correlationId: incident?.correlationId })
}

export const flushNativeMediaDiagnosticsEffect = Effect.fn(
  'nativeMedia.flushDiagnostics',
)(function*() {
  if (diagnosticLog) yield* diagnosticLog.flushEffect()
})

export function registerNativeMediaRuntimeIpc(
  getWindow: () => BrowserWindow | null,
) {
  if (registered) return
  registered = true
  windowGetter = getWindow

  ipcMain.handle(IPC.mediaGetRuntimeState, (event) => {
    assertTrustedSender(event, getWindow)
    return runtimeState()
  })
  ipcMain.handle(IPC.mediaRetryRuntime, async (event) => {
    assertTrustedSender(event, getWindow)
    if (active && mediaUtilityAvailable()) await active.runtime.retry()
    return runtimeState()
  })
  ipcMain.handle(IPC.mediaListDevices, async (event, value: unknown) => {
    if (!isTrustedSender(event, getWindow)) return []
    const kind = decodeIpcInput(IPC.mediaListDevices, 'kind', Schema.Literals(['audioinput', 'audiooutput', 'videoinput']), value)
    const bundle = active
    if (!bundle || !mediaUtilityAvailable()) return []
    await bundle.runtime.start()
    const epoch = bundle.runtime.getHostEpoch()
    const deadline = Date.now() + 1_000
    let inventory = await bundle.runtime.queryInventory()
    while ((kind === 'videoinput' ? inventory.cameras.revision : inventory.audio.revision) === 0 &&
        Date.now() < deadline && active === bundle && epoch === bundle.runtime.getHostEpoch()) {
      await delay(25)
      inventory = await bundle.runtime.queryInventory()
    }
    if (active !== bundle || epoch !== bundle.runtime.getHostEpoch()) return []
    if (kind === 'videoinput') return inventory.cameras.devices.filter(device => device.available)
      .map(device => ({ deviceId: device.id, label: device.label, kind }))
    const direction = kind === 'audioinput' ? 'input' : 'output'
    return inventory.audio.devices.filter(device => device.direction === direction)
      .map(device => ({ deviceId: device.id, label: device.label, kind }))
  })
  ipcMain.handle(IPC.mediaStartMicrophonePreview, async (event) => {
    assertTrustedSender(event, getWindow)
    if (!active || !mediaUtilityAvailable()) throw unavailableError()
    await active.adapter.setMicrophonePreview(true)
  })
  ipcMain.handle(IPC.mediaStopMicrophonePreview, async (event) => {
    assertTrustedSender(event, getWindow)
    await active?.adapter.setMicrophonePreview(false)
    const window = getWindow()
    if (window && !window.isDestroyed()) window.webContents.send(IPC.mediaMicrophonePreviewState, { status: 'stopped' })
  })
  ipcMain.handle(IPC.mediaOpenDisplayPicker, (event, value: unknown) => {
    assertTrustedSender(event, getWindow)
    const audioRequested = decodeIpcInput(IPC.mediaOpenDisplayPicker, 'audioRequested', Schema.Boolean, value)
    if (!active || !mediaUtilityAvailable()) throw unavailableError()
    return active.picker.open(audioRequested)
  })
  ipcMain.handle(IPC.mediaSetRemoteVideoDemand, (event, sessionId: unknown, generation: unknown, trackId: unknown, demanded: unknown) => {
    assertTrustedSender(event, getWindow)
    const demand = decodeIpcInput(IPC.mediaSetRemoteVideoDemand, 'demand', Schema.Struct({
      sessionId: Schema.String.check(Schema.isMaxLength(512)),
      generation: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
      trackId: Schema.String.check(Schema.isMaxLength(512)), demanded: Schema.Boolean,
    }), { sessionId, generation, trackId, demanded })
    active?.frames.setRemoteDemand(demand.sessionId, demand.generation, demand.trackId, demand.demanded)
  })
  ipcMain.handle(IPC.mediaReplayRemoteVideoPublications, (event) => {
    assertTrustedSender(event, getWindow)
    rendererListening = true
    active?.frames.rendererReady()
  })
  ipcMain.handle(IPC.mediaSetLocalScreenPreviewDemand, (event, value: unknown) => {
    assertTrustedSender(event, getWindow)
    const demand = decodeIpcInput(IPC.mediaSetLocalScreenPreviewDemand, 'demand', LocalScreenPreviewDemandSchema, value)
    active?.frames.setScreenPreview(demand.demanded)
  })
}
