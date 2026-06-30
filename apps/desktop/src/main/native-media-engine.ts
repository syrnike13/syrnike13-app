import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import readline from 'node:readline'

import { app, ipcMain, type BrowserWindow, type IpcMainInvokeEvent } from 'electron'
import {
  IPC,
  type DesktopDisplayMediaRequest,
  type DesktopDisplayMediaSource,
  type DesktopOs,
  type NativeMediaAudioMode,
  type NativeMediaDeviceInfo,
  type NativeMediaEchoCancellationMode,
  type NativeMediaEngineSessionSummary,
  type NativeMediaFrameMethod,
  type NativeMediaFrameStats,
  type NativeMediaLoopbackMode,
  type NativeMediaNoiseSuppressionMode,
  type NativeMediaScreenAudioMode,
  type NativeMediaSessionKind,
  type NativeMicrophonePreviewSession,
  type NativeMicrophonePreviewStartOptions,
  type NativeMicrophoneRuntimeConfig,
  type NativeMediaLiveKitCredentials,
  type NativeMediaMicrophoneSessionStartOptions,
  type NativeMediaScreenSessionPrepareOptions,
  type NativeMediaSession,
  type NativeMediaSidecarLostEvent,
  type NativeMediaSessionStartOptions,
  type NativeMediaSessionStatus,
  type NativeMediaState,
  type NativeMediaStateEvent,
  type NativeMediaStatsEvent,
  type NativeMicrophoneMetricsEvent,
} from '@syrnike13/platform'

import {
  mapAudioMode,
  mapEncoderBackend,
  mapEchoCancellationMode,
  mapFrameMethod,
  mapLifecycleState,
  mapLoopbackMode,
  mapMicrophoneMetrics,
  mapNoiseSuppressionMode,
  parseSidecarEvent,
  type SidecarEvent,
} from './native-media-engine-sidecar'

const NATIVE_PICKER_TIMEOUT_MS = 120_000
const MAX_SIDECAR_RECONNECT_ATTEMPTS = 1
const WARMED_MICROPHONE_SESSION_ID = 'native-microphone-monitor'
const NATIVE_MEDIA_STOP_TIMEOUT_MS = 5_000
const NATIVE_MEDIA_DEBUG_AGENT_ENDPOINT =
  'http://127.0.0.1:37729/ingest/88f771'

function logNativeMediaDebugAgent(payload: Record<string, unknown>) {
  if (app.isPackaged || process.env.NODE_ENV === 'production') return
  if (process.env.NODE_ENV === 'test') return
  const debugFetch = globalThis.fetch
  if (!debugFetch) return

  // #region debug log
  void debugFetch(NATIVE_MEDIA_DEBUG_AGENT_ENDPOINT, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      area: 'native-media-slice',
      timestamp: Date.now(),
      ...payload,
    }),
  }).catch(() => {})
  // #endregion
}

export type PendingNativePicker = {
  id: string
  audioRequested: boolean
  sources: DesktopDisplayMediaSource[]
  timeout: ReturnType<typeof setTimeout>
}

type ActiveMediaEngineSessionAudio = {
  port?: number
  mode: NativeMediaAudioMode
  sampleRate?: 48_000
  channels?: 1 | 2
  noiseSuppression?: NativeMediaNoiseSuppressionMode
  echoCancellation?: NativeMediaEchoCancellationMode
  targetProcessId?: number
  loopbackMode?: NativeMediaLoopbackMode
}

type ActiveMediaEngineSession = {
  sessionId: string
  debugStartedAtMs: number
  port?: number
  frameBufferPath?: string
  width?: number
  height?: number
  fps?: number
  bitrate?: number
  audio?: ActiveMediaEngineSessionAudio
  helper: ChildProcessWithoutNullStreams
  stats: NativeMediaFrameStats
  activeMethod?: NativeMediaFrameMethod
  publishedVideo: boolean
  publishedAudio: boolean
  audioFrames?: number
  audioPackets?: number
  audioPeakDb?: number
  audioRmsDb?: number
  videoFrames?: number
  videoIntervalFrames?: number
  videoLateFrames?: number
  videoNoFrameCount?: number
  videoRepeatedFrameCount?: number
  videoRecoverableLostCount?: number
  videoAvgCaptureUs?: number
  videoAvgReadbackUs?: number
  videoAvgScaleUs?: number
  videoAvgPublishUs?: number
  videoSourceWidth?: number
  videoSourceHeight?: number
  videoContentWidth?: number
  videoContentHeight?: number
  captureThreadMmcss?: boolean
  startOptions: NativeMediaSessionStartOptions
  effectiveMicrophoneConfig?: NativeMicrophoneRuntimeConfig
  effectiveMuted?: boolean
  reconnectAttempts: number
  reconnecting: boolean
  stopping: boolean
  reconnectHelper?: ChildProcessWithoutNullStreams
  reader?: readline.Interface
}

export type NativeMediaReconnectState = {
  startOptions: NativeMediaSessionStartOptions
  effectiveMicrophoneConfig?: NativeMicrophoneRuntimeConfig
  effectiveMuted?: boolean
}

export type NativeMediaHelperExitState = {
  helper: ChildProcessWithoutNullStreams
  reconnecting: boolean
  reconnectHelper?: ChildProcessWithoutNullStreams
}

type PendingStopResolver = {
  resolve: () => void
  reject: (error: Error) => void
  timeout: ReturnType<typeof setTimeout>
  wait: Promise<void>
}
type PendingStartResolver = (event: SidecarEvent) => void

export type NativeMediaStartupDiagnostics = {
  sessionId: string
  lastLifecycleStatus?: string
  lastLifecycleMessage?: string
  stderrLines: string[]
}

const MAX_STARTUP_DIAGNOSTIC_LINES = 4
const MAX_STARTUP_DIAGNOSTIC_LINE_LENGTH = 240

export function createPendingStartResolverRegistry() {
  const resolvers = new Map<string, Set<PendingStartResolver>>()

  return {
    set(sessionId: string, resolver: PendingStartResolver) {
      let sessionResolvers = resolvers.get(sessionId)
      if (!sessionResolvers) {
        sessionResolvers = new Set()
        resolvers.set(sessionId, sessionResolvers)
      }
      sessionResolvers.add(resolver)

      return () => {
        const current = resolvers.get(sessionId)
        if (!current) return
        current.delete(resolver)
        if (current.size === 0) {
          resolvers.delete(sessionId)
        }
      }
    },

    get(sessionId: string) {
      const sessionResolvers = resolvers.get(sessionId)
      if (!sessionResolvers) return undefined

      return (event: SidecarEvent) => {
        for (const resolver of Array.from(sessionResolvers)) {
          resolver(event)
        }
      }
    },

    delete(sessionId: string) {
      return resolvers.delete(sessionId)
    },

    clear() {
      resolvers.clear()
    },

    count(sessionId: string) {
      return resolvers.get(sessionId)?.size ?? 0
    },
  }
}

let mediaEngineIpcRegistered = false
let activeSession: ActiveMediaEngineSession | null = null
const activeSessions = new Map<string, ActiveMediaEngineSession>()
const mediaEngineHelperReaders = new WeakMap<
  ChildProcessWithoutNullStreams,
  readline.Interface
>()
const pendingStartResolvers = createPendingStartResolverRegistry()
const startupDiagnostics = new Map<string, NativeMediaStartupDiagnostics>()
const pendingStopResolvers = new Map<string, PendingStopResolver>()
let mediaEngineStatus: NativeMediaSessionStatus = { status: 'idle' }
let lastMediaEngineError: string | null = null
let pendingNativePicker: PendingNativePicker | null = null
let getWindowRef: (() => BrowserWindow | null) | null = null
const startSessionQueues: Record<NativeMediaSessionKind, Promise<unknown>> = {
  microphone: Promise.resolve(),
  screen: Promise.resolve(),
}
let latestStartRequestIds: Partial<Record<NativeMediaSessionKind, string>> = {}
let microphonePreviewHelper: ChildProcessWithoutNullStreams | null = null
let microphonePreviewSessionId: string | null = null
let prewarmedMediaEngineHelper: ChildProcessWithoutNullStreams | null = null
let prewarmedMediaEngineReader: readline.Interface | null = null
let preconnectedScreenSession: {
  sessionId: string
  helper: ChildProcessWithoutNullStreams
  livekitKey: string
  ready: Promise<void>
} | null = null
let microphoneWarmupEnabled = false
let microphoneWarmupRestartTimer: NodeJS.Timeout | null = null
const microphoneWarmExitHandlers = new WeakSet<ChildProcessWithoutNullStreams>()
const orphanMediaEngineHelpers = new WeakSet<ChildProcessWithoutNullStreams>()

function isTrustedSender(
  event: IpcMainInvokeEvent,
  getWindow: () => BrowserWindow | null,
) {
  const win = getWindow()
  return Boolean(win && !win.isDestroyed() && event.sender === win.webContents)
}

function emptyStats(): NativeMediaFrameStats {
  return {
    wgc: 0,
    dxgi: 0,
    gdi_blt: 0,
    gdi_print: 0,
  }
}

function buildSessionAudio(
  requested: boolean | undefined,
  mode: NativeMediaAudioMode,
  port: number | undefined,
  metadata?: {
    sampleRate?: 48_000
    channels?: 1 | 2
    noiseSuppression?: NativeMediaNoiseSuppressionMode
    echoCancellation?: NativeMediaEchoCancellationMode
    targetProcessId?: number
    loopbackMode?: NativeMediaLoopbackMode
  },
): ActiveMediaEngineSessionAudio | undefined {
  if (!requested && mode === 'none' && !port) return undefined
  if (mode === 'microphone') {
    return {
      mode,
      port,
      sampleRate: metadata?.sampleRate ?? 48_000,
      channels: 1,
      noiseSuppression: metadata?.noiseSuppression ?? 'disabled',
      echoCancellation: metadata?.echoCancellation ?? 'disabled',
    }
  }
  return {
    mode,
    port,
    targetProcessId: metadata?.targetProcessId,
    loopbackMode: metadata?.loopbackMode,
  }
}

function readWindowHwnd(win: BrowserWindow): string | undefined {
  const handle = win.getNativeWindowHandle()
  if (handle.length < 4) return undefined
  if (handle.length >= 8) return handle.readBigUInt64LE(0).toString()
  return handle.readUInt32LE(0).toString()
}

export function buildNativeMediaStartCommand(
  options: NativeMediaSessionStartOptions,
  sessionId: string,
  getWindow: () => BrowserWindow | null,
) {
  if (options.kind === 'microphone') {
    return {
      cmd: 'connect_microphone',
      sessionId,
      sessionKind: options.kind,
      deviceId: options.deviceId,
      sampleRate: options.sampleRate,
      channels: options.channels,
      audioBitrate: options.audioBitrate,
      noiseSuppression: options.noiseSuppression,
      echoCancellation: options.echoCancellation,
      inputVolume: options.inputVolume,
      voiceGateEnabled: options.voiceGateEnabled,
      voiceGateThresholdDb: options.voiceGateThresholdDb,
      voiceGateAutoThreshold: options.voiceGateAutoThreshold,
      muted: options.muted,
      url: options.livekit.url,
      token: options.livekit.token,
      participantIdentity: options.livekit.participantIdentity,
      livekit: options.livekit,
    }
  }

  const win = getWindow()
  return {
    cmd: 'start',
    sessionId,
    sessionKind: options.kind,
    sourceId: options.sourceId,
    target: { id: options.sourceId },
    width: options.width,
    height: options.height,
    fps: options.fps,
    bitrate: options.bitrate,
    audioBitrate: options.audioBitrate,
    audio: Boolean(options.audio?.requested),
    url: options.livekit.url,
    token: options.livekit.token,
    participantIdentity: options.livekit.participantIdentity,
    livekit: options.livekit,
    excludeProcessId: process.pid,
    selfWindowHwnd:
      win && !win.isDestroyed() ? readWindowHwnd(win) : undefined,
  }
}

function buildNativeMediaReconnectStartOptions(
  session: NativeMediaReconnectState,
): NativeMediaSessionStartOptions {
  if (session.startOptions.kind !== 'microphone') {
    return session.startOptions
  }

  return {
    ...session.startOptions,
    ...session.effectiveMicrophoneConfig,
    muted: session.effectiveMuted ?? session.startOptions.muted,
  }
}

export function buildNativeMediaReconnectStartCommand(
  session: NativeMediaReconnectState,
  sessionId: string,
  getWindow: () => BrowserWindow | null,
) {
  return buildNativeMediaStartCommand(
    buildNativeMediaReconnectStartOptions(session),
    sessionId,
    getWindow,
  )
}

function buildScreenShareStartCommand(
  options: Extract<NativeMediaSessionStartOptions, { kind: 'screen' }>,
  sessionId: string,
  getWindow: () => BrowserWindow | null,
) {
  return buildNativeMediaStartCommand(options, sessionId, getWindow)
}

export function buildScreenSharePreflightCommand(
  options: Extract<NativeMediaSessionStartOptions, { kind: 'screen' }>,
  getWindow: () => BrowserWindow | null,
) {
  return {
    ...buildNativeMediaStartCommand(options, 'preflight', getWindow),
    cmd: 'probe_screen_share',
    durationMs: 1000,
  }
}

function assertScreenSessionOptions(
  options: NativeMediaSessionStartOptions,
): asserts options is Extract<NativeMediaSessionStartOptions, { kind: 'screen' }> {
  if (options.kind !== 'screen') {
    throw new Error(`Unsupported native media session kind: ${String(options.kind)}`)
  }
}

function resolveMediaEngineHelperPath(
  kind: NativeMediaSessionStartOptions['kind'] = 'screen',
) {
  const helperName = 'syrnike-native-voice-win.exe'
  const candidates = app.isPackaged
    ? [path.join(process.resourcesPath, 'native', helperName)]
    : [
        path.resolve(app.getAppPath(), 'out/native', helperName),
        path.resolve(
          app.getAppPath(),
          'native/native-voice-win/build/Release',
          helperName,
        ),
        path.resolve(
          app.getAppPath(),
          'native/native-voice-win/build/Debug',
          helperName,
        ),
      ]

  return candidates.find((candidate) => fs.existsSync(candidate)) ?? null
}

function emitMediaEngineState(
  getWindow: () => BrowserWindow | null,
  next: NativeMediaStateEvent,
) {
  mediaEngineStatus = next
  if (next.status === 'error') {
    lastMediaEngineError = next.message
  }
  const win = getWindow()
  if (!win || win.isDestroyed()) return
  win.webContents.send(IPC.mediaStateChanged, next)
}

type NativeMediaEngineSnapshotInput = {
  platform: NodeJS.Platform | DesktopOs
  helperAvailable: boolean
  microphoneHelperAvailable?: boolean
  helperRunning: boolean
  activeSession: ActiveMediaEngineSession | null
  activeSessions?: Iterable<ActiveMediaEngineSession>
  lastError: string | null
  status?: NativeMediaSessionStatus
}

function buildNativeMediaEngineSessionSummary(
  session: ActiveMediaEngineSession,
): NativeMediaEngineSessionSummary {
  const audio = session.audio
  const common = {
    sessionId: session.sessionId,
    status: 'running' as const,
    port: session.port,
    width: session.width,
    height: session.height,
    fps: session.fps,
    bitrate: session.bitrate,
  }

  if (
    session.startOptions?.kind === 'microphone' ||
    audio?.mode === 'microphone'
  ) {
    return {
      ...common,
      kind: 'microphone',
      audio:
        audio?.mode === 'microphone' ?
          {
            mode: 'microphone',
            port: audio.port,
            sampleRate: audio.sampleRate,
            channels: audio.channels,
            noiseSuppression: audio.noiseSuppression,
            echoCancellation: audio.echoCancellation,
          }
        : undefined,
    }
  }

  return {
    ...common,
    kind: 'screen',
    audio: audio ?
      {
        mode: audio.mode as NativeMediaScreenAudioMode,
        port: audio.port,
        targetProcessId: audio.targetProcessId,
        loopbackMode: audio.loopbackMode,
      }
    : undefined,
  }
}

export function buildNativeMediaEngineSnapshot(
  input: NativeMediaEngineSnapshotInput,
): NativeMediaState {
  const supportsNativeMedia = input.platform === 'win32'
  const microphoneHelperAvailable = input.microphoneHelperAvailable ?? false
  const anyHelperAvailable = input.helperAvailable || microphoneHelperAvailable
  const sessions = input.activeSessions
    ? Array.from(input.activeSessions)
    : input.activeSession
      ? [input.activeSession]
      : []
  const activeSessions: NativeMediaEngineSessionSummary[] = sessions.map(
    (session) => buildNativeMediaEngineSessionSummary(session),
  )

  return {
    ...(input.status ?? { status: 'idle' }),
    engine: {
      available: supportsNativeMedia && anyHelperAvailable,
      helper: {
        available: anyHelperAvailable,
        running: input.helperRunning,
      },
      capabilities: {
        screen: supportsNativeMedia && input.helperAvailable,
        systemAudio: supportsNativeMedia && input.helperAvailable,
        microphone:
          supportsNativeMedia &&
          microphoneHelperAvailable,
        camera: false,
      },
      activeSessions,
      lastError: input.lastError,
    },
  }
}

function getNativeMediaEngineState(): NativeMediaState {
  return buildNativeMediaEngineSnapshot({
    platform: process.platform,
    helperAvailable: Boolean(resolveMediaEngineHelperPath()),
    microphoneHelperAvailable: Boolean(resolveMediaEngineHelperPath('microphone')),
    helperRunning:
      activeSessions.size > 0 || isHelperWritable(prewarmedMediaEngineHelper),
    activeSession,
    activeSessions: activeSessions.values(),
    lastError: lastMediaEngineError,
    status: mediaEngineStatus,
  })
}

function emitMediaEngineStats(
  getWindow: () => BrowserWindow | null,
  event: NativeMediaStatsEvent,
) {
  const win = getWindow()
  if (!win || win.isDestroyed()) return
  win.webContents.send(IPC.mediaStats, event)
}

function buildMediaEngineStatsEvent(
  session: ActiveMediaEngineSession,
): NativeMediaStatsEvent {
  return {
    sessionId: session.sessionId,
    methods: { ...session.stats },
    activeMethod: session.activeMethod,
    publishedVideo: session.publishedVideo,
    publishedAudio: session.publishedAudio,
    audioFrames: session.audioFrames,
    audioPackets: session.audioPackets,
    audioPeakDb: session.audioPeakDb,
    audioRmsDb: session.audioRmsDb,
    videoFrames: session.videoFrames,
    videoIntervalFrames: session.videoIntervalFrames,
    videoLateFrames: session.videoLateFrames,
    videoNoFrameCount: session.videoNoFrameCount,
    videoRepeatedFrameCount: session.videoRepeatedFrameCount,
    videoRecoverableLostCount: session.videoRecoverableLostCount,
    videoAvgCaptureUs: session.videoAvgCaptureUs,
    videoAvgReadbackUs: session.videoAvgReadbackUs,
    videoAvgScaleUs: session.videoAvgScaleUs,
    videoAvgPublishUs: session.videoAvgPublishUs,
    videoSourceWidth: session.videoSourceWidth,
    videoSourceHeight: session.videoSourceHeight,
    videoContentWidth: session.videoContentWidth,
    videoContentHeight: session.videoContentHeight,
    captureThreadMmcss: session.captureThreadMmcss,
  }
}

function emitMicrophoneMetrics(
  getWindow: () => BrowserWindow | null,
  event: NativeMicrophoneMetricsEvent,
) {
  const win = getWindow()
  if (!win || win.isDestroyed()) return
  win.webContents.send(IPC.mediaMicrophoneMetrics, event)
}

function emitSidecarLost(
  getWindow: () => BrowserWindow | null,
  event: NativeMediaSidecarLostEvent,
) {
  const win = getWindow()
  if (!win || win.isDestroyed()) return
  win.webContents.send(IPC.mediaEngineLost, event)
}

function startupDiagnosticsFor(sessionId: string) {
  let diagnostics = startupDiagnostics.get(sessionId)
  if (!diagnostics) {
    diagnostics = { sessionId, stderrLines: [] }
    startupDiagnostics.set(sessionId, diagnostics)
  }
  return diagnostics
}

function sanitizeNativeMediaStartupDiagnosticLine(line: string) {
  return line
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^\[[^\]]+\]\s*/, '')
    .replace(
      /\b(token|access_token|authorization)\s*[:=]\s*([^\s,;]+)/gi,
      '$1=[redacted]',
    )
    .replace(/\bBearer\s+[A-Za-z0-9._-]+/gi, 'Bearer [redacted]')
    .replace(
      /[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g,
      '[redacted]',
    )
    .slice(0, MAX_STARTUP_DIAGNOSTIC_LINE_LENGTH)
}

function recordNativeMediaStartupStderr(sessionId: string, text: string) {
  const diagnostics = startupDiagnosticsFor(sessionId)
  for (const rawLine of text.split(/\r?\n/)) {
    const line = sanitizeNativeMediaStartupDiagnosticLine(rawLine)
    if (!line) continue
    diagnostics.stderrLines.push(line)
    while (diagnostics.stderrLines.length > MAX_STARTUP_DIAGNOSTIC_LINES) {
      diagnostics.stderrLines.shift()
    }
  }
}

function recordNativeMediaHelperStderr(
  helper: ChildProcessWithoutNullStreams,
  fallbackSessionId: string,
  text: string,
) {
  const sessionIds = new Set([fallbackSessionId])

  for (const session of activeSessions.values()) {
    if (session.helper === helper || session.reconnectHelper === helper) {
      sessionIds.add(session.sessionId)
    }
  }

  if (preconnectedScreenSession?.helper === helper) {
    sessionIds.add(preconnectedScreenSession.sessionId)
  }

  for (const sessionId of sessionIds) {
    recordNativeMediaStartupStderr(sessionId, text)
  }
}

function recordNativeMediaStartupLifecycle(
  event: Extract<SidecarEvent, { type: 'session_lifecycle' }>,
) {
  const diagnostics = startupDiagnosticsFor(event.session_id)
  diagnostics.lastLifecycleStatus = event.status
  diagnostics.lastLifecycleMessage = event.message
}

function startupDiagnosticSuffix(
  diagnostics: NativeMediaStartupDiagnostics | undefined,
) {
  if (!diagnostics) return ''

  const stage =
    diagnostics.lastLifecycleMessage ?? diagnostics.lastLifecycleStatus
  const stderrLine =
    diagnostics.stderrLines.length > 0
      ? sanitizeNativeMediaStartupDiagnosticLine(
          diagnostics.stderrLines[diagnostics.stderrLines.length - 1],
        )
      : undefined
  const stageText = stage ? ` while ${stage}` : ''
  const stderrText = stderrLine ? `: ${stderrLine}` : ''
  return `${stageText}${stderrText}`
}

export function buildNativeMediaStartupTimeoutMessage(
  diagnostics?: NativeMediaStartupDiagnostics,
) {
  return `Native media engine timed out${startupDiagnosticSuffix(diagnostics)}`
}

function buildNativeMediaStartupFailureMessage(
  message: string,
  diagnostics?: NativeMediaStartupDiagnostics,
) {
  return `${message}${startupDiagnosticSuffix(diagnostics)}`
}

function writeHelperCommand(
  helper: ChildProcessWithoutNullStreams,
  command: Record<string, unknown>,
) {
  if (helper.killed || helper.exitCode !== null || !helper.stdin.writable) {
    return false
  }

  try {
    return helper.stdin.write(`${JSON.stringify(command)}\n`, (error) => {
      if (!error) return
      if ((error as NodeJS.ErrnoException).code === 'EPIPE') return
      console.error('[media-engine-helper] stdin write failed', error)
    })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EPIPE') {
      console.error('[media-engine-helper] stdin write failed', error)
    }
    return false
  }
}

function isHelperWritable(
  helper: ChildProcessWithoutNullStreams | null,
): helper is ChildProcessWithoutNullStreams {
  return Boolean(
    helper &&
      !helper.killed &&
      helper.exitCode === null &&
      helper.stdin.writable,
  )
}

export function shouldHandleNativeMediaHelperExit(
  session: NativeMediaHelperExitState,
  helper: ChildProcessWithoutNullStreams,
) {
  if (session.reconnecting && session.helper === helper) return false
  return session.helper === helper || session.reconnectHelper === helper
}

function nativeScreenLiveKitKey(livekit: NativeMediaLiveKitCredentials) {
  return `${livekit.url}\n${livekit.participantIdentity}`
}

function closeMediaEngineHelperReader(helper: ChildProcessWithoutNullStreams) {
  mediaEngineHelperReaders.get(helper)?.close()
  mediaEngineHelperReaders.delete(helper)
}

function helperHasActiveSession(helper: ChildProcessWithoutNullStreams) {
  return Array.from(activeSessions.values()).some(
    (session) => session.helper === helper || session.reconnectHelper === helper,
  )
}

function closeIdleMediaEngineHelperReader(helper: ChildProcessWithoutNullStreams) {
  if (helperHasActiveSession(helper)) return
  if (preconnectedScreenSession?.helper === helper) return
  if (prewarmedMediaEngineHelper === helper) return
  closeMediaEngineHelperReader(helper)
}

function reconcileUnownedMediaEngineHelperEvent(
  helper: ChildProcessWithoutNullStreams,
  reason: string,
) {
  if (helperHasActiveSession(helper)) return false
  if (preconnectedScreenSession?.helper === helper) return false
  if (prewarmedMediaEngineHelper === helper) {
    closeMediaEngineHelperReader(helper)
    return true
  }
  if (orphanMediaEngineHelpers.has(helper)) return true
  orphanMediaEngineHelpers.add(helper)
  logNativeMediaDebugAgent({
    hypothesis: 'H5-orphan-native-helper',
    event: 'native-orphan-helper-stopped',
    reason,
    helperPid: helper.pid,
  })
  closeMediaEngineHelperReader(helper)
  if (isHelperWritable(helper)) {
    writeHelperCommand(helper, { cmd: 'stop' })
  }
  helper.kill()
  return true
}

function clearPreconnectedScreenSession(force = false) {
  const prepared = preconnectedScreenSession
  preconnectedScreenSession = null
  if (!prepared) return
  const helper = prepared.helper
  const helperWritable =
    !helper.killed && helper.exitCode === null && helper.stdin.writable
  if (helperWritable) {
    writeHelperCommand(helper, {
      cmd: 'stop',
      sessionId: prepared.sessionId,
    })
  } else {
    closeMediaEngineHelperReader(helper)
    helper.kill()
  }
  if (force) {
    helper.kill()
  }
}

function spawnNativeMediaEngineProcess(
  kind: NativeMediaSessionStartOptions['kind'],
) {
  const helperPath = resolveMediaEngineHelperPath(kind)
  if (!helperPath) {
    throw new Error('Native media engine is not available')
  }

  return spawn(helperPath, [], {
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  })
}

function takePrewarmedMediaEngineHelper() {
  if (!isHelperWritable(prewarmedMediaEngineHelper)) {
    disposePrewarmedMicrophoneHelper(prewarmedMediaEngineHelper)
    return null
  }

  const helper = prewarmedMediaEngineHelper
  prewarmedMediaEngineHelper = null
  prewarmedMediaEngineReader?.close()
  prewarmedMediaEngineReader = null
  return helper
}

function clearMicrophoneWarmupRestartTimer() {
  if (!microphoneWarmupRestartTimer) return
  clearTimeout(microphoneWarmupRestartTimer)
  microphoneWarmupRestartTimer = null
}

function queueMicrophoneWarmupRestart() {
  if (!microphoneWarmupEnabled) return
  if (microphoneWarmupRestartTimer) return
  microphoneWarmupRestartTimer = setTimeout(() => {
    microphoneWarmupRestartTimer = null
    prewarmNativeMediaEngineHelper()
  }, 250)
}

function attachPrewarmedMicrophoneReader(helper: ChildProcessWithoutNullStreams) {
  prewarmedMediaEngineReader?.close()
  const reader = readline.createInterface({ input: helper.stdout })
  prewarmedMediaEngineReader = reader
  reader.on('line', (line) => {
    const event = parseSidecarEvent(line)
    if (!event) return
    if (event.type === 'microphone_metrics') {
      if (getWindowRef) {
        emitMicrophoneMetrics(getWindowRef, mapMicrophoneMetrics(event))
      }
      return
    }
    if (event.type === 'microphone_diagnostics') {
      console.info('[media-engine-helper:warm] microphone diagnostics', event)
    }
  })
}

function attachPrewarmedMicrophoneExitHandler(
  helper: ChildProcessWithoutNullStreams,
) {
  if (microphoneWarmExitHandlers.has(helper)) return
  microphoneWarmExitHandlers.add(helper)
  helper.on('exit', () => {
    if (prewarmedMediaEngineHelper === helper) {
      prewarmedMediaEngineHelper = null
      prewarmedMediaEngineReader?.close()
      prewarmedMediaEngineReader = null
      queueMicrophoneWarmupRestart()
    }
  })
}

function disposePrewarmedMicrophoneHelper(
  helper: ChildProcessWithoutNullStreams | null,
) {
  if (!helper) return
  if (prewarmedMediaEngineHelper === helper) {
    prewarmedMediaEngineHelper = null
  }
  prewarmedMediaEngineReader?.close()
  prewarmedMediaEngineReader = null
  closeMediaEngineHelperReader(helper)
  if (isHelperWritable(helper)) {
    writeHelperCommand(helper, { cmd: 'stop' })
  }
  helper.kill()
}

function keepMicrophoneHelperWarmed(helper: ChildProcessWithoutNullStreams) {
  if (!isHelperWritable(helper)) {
    queueMicrophoneWarmupRestart()
    return
  }
  const previousHelper = prewarmedMediaEngineHelper
  if (previousHelper && previousHelper !== helper) {
    disposePrewarmedMicrophoneHelper(previousHelper)
  }
  prewarmedMediaEngineHelper = helper
  attachPrewarmedMicrophoneReader(helper)
  attachPrewarmedMicrophoneExitHandler(helper)
}

function selectPrimaryActiveSession() {
  const runningSessions = Array.from(activeSessions.values()).filter(
    (active) => !active.stopping,
  )
  return (
    runningSessions.find((active) => active.startOptions.kind === 'screen') ??
    runningSessions[0] ??
    null
  )
}

function runningStatusForSession(
  session: ActiveMediaEngineSession,
): NativeMediaSessionStatus {
  if (session.startOptions.kind !== 'screen') {
    return { status: 'running', sessionId: session.sessionId }
  }
  return {
    status: 'running',
    sessionId: session.sessionId,
    port: session.port,
    width: session.width,
    height: session.height,
    fps: session.fps,
    bitrate: session.bitrate,
  }
}

function refreshStatusFromActiveSessions() {
  activeSession = selectPrimaryActiveSession()
  mediaEngineStatus = activeSession
    ? runningStatusForSession(activeSession)
    : { status: 'idle' }
  if (getWindowRef) {
    emitMediaEngineState(getWindowRef, mediaEngineStatus)
  }
}

function eventSessionIdForHelper(
  helper: ChildProcessWithoutNullStreams,
  fallbackSessionId: string,
  event: SidecarEvent,
) {
  if ('session_id' in event && typeof event.session_id === 'string') {
    return event.session_id
  }
  const helperSessions = Array.from(activeSessions.values()).filter(
    (session) => session.helper === helper,
  )
  return helperSessions.length === 1
    ? helperSessions[0].sessionId
    : fallbackSessionId
}

export function prewarmNativeMediaEngineHelper(
  options: { allowDuringMicrophoneSession?: boolean } = {},
) {
  if (process.platform !== 'win32') return
  microphoneWarmupEnabled = true
  clearMicrophoneWarmupRestartTimer()
  if (isHelperWritable(prewarmedMediaEngineHelper)) return
  disposePrewarmedMicrophoneHelper(prewarmedMediaEngineHelper)
  if (
    !options.allowDuringMicrophoneSession &&
    Array.from(activeSessions.values()).some(
      (session) => session.startOptions.kind === 'microphone',
    )
  ) {
    return
  }
  if (!resolveMediaEngineHelperPath('microphone')) return

  try {
    const helper = spawnNativeMediaEngineProcess('microphone')
    prewarmedMediaEngineHelper = helper
    attachPrewarmedMicrophoneReader(helper)
    helper.stderr.on('data', (chunk) => {
      console.error('[media-engine-helper:warm]', chunk.toString())
    })
    helper.stdin.on('error', (error) => {
      if ((error as NodeJS.ErrnoException).code === 'EPIPE') return
      console.error('[media-engine-helper:warm] stdin error', error)
    })
    attachPrewarmedMicrophoneExitHandler(helper)
    writeHelperCommand(helper, {
      cmd: 'warm_microphone',
      sessionId: WARMED_MICROPHONE_SESSION_ID,
    })
  } catch (error) {
    console.warn('[media-engine-helper] failed to prewarm helper', error)
  }
}

export function disposePrewarmedNativeMediaEngineHelper() {
  microphoneWarmupEnabled = false
  clearMicrophoneWarmupRestartTimer()
  disposePrewarmedMicrophoneHelper(prewarmedMediaEngineHelper)
}

export function getPendingNativePicker() {
  return pendingNativePicker
}

export function setPendingNativePicker(next: PendingNativePicker | null) {
  pendingNativePicker = next
}

export function clearPendingNativePicker() {
  if (!pendingNativePicker) return
  clearTimeout(pendingNativePicker.timeout)
  pendingNativePicker = null
}

function notifySidecarLost(
  session: ActiveMediaEngineSession,
  reason: NativeMediaSidecarLostEvent['reason'],
  message: string,
) {
  const getWindow = getWindowRef
  if (!getWindow) return

  emitSidecarLost(getWindow, {
    sessionId: session.sessionId,
    reason,
    message,
  })

  const win = getWindow()
  if (win && !win.isDestroyed()) {
    win.webContents.send(IPC.mediaStreamError, {
      sessionId: session.sessionId,
      message,
    })
    win.webContents.send(IPC.mediaStreamEnded, session.sessionId)
  }
}

async function attemptSidecarReconnect(session: ActiveMediaEngineSession) {
  if (session.reconnecting) return false
  if (session.reconnectAttempts >= MAX_SIDECAR_RECONNECT_ATTEMPTS) return false

  session.reconnecting = true
  session.reconnectAttempts += 1

  const getWindow = getWindowRef
  if (!getWindow) {
    session.reconnecting = false
    return false
  }

  try {
    writeHelperCommand(session.helper, { cmd: 'stop' })
    session.helper.kill()
    closeMediaEngineHelperReader(session.helper)

    const reconnectOptions = buildNativeMediaReconnectStartOptions(session)
    const helper = spawnMediaEngineHelper(reconnectOptions.kind, session.sessionId)
    session.reconnectHelper = helper
    const readyPromise = waitForSidecarReady(session.sessionId)
    writeHelperCommand(
      helper,
      buildNativeMediaReconnectStartCommand(
        session,
        session.sessionId,
        getWindow,
      ),
    )

    const readyEvent = await readyPromise
    if (readyEvent.type !== 'ready') {
      throw new Error('Native media engine reconnect failed')
    }

    session.port =
      reconnectOptions.kind === 'screen' ? readyEvent.port : undefined
    session.frameBufferPath =
      reconnectOptions.kind === 'screen'
        ? readyEvent.frame_buffer_path
        : undefined
    session.width = readyEvent.width
    session.height = readyEvent.height
    session.fps = readyEvent.fps
    session.bitrate = readyEvent.bitrate
    const audioMode = mapAudioMode(readyEvent.audio_mode)
    session.audio = buildSessionAudio(
      reconnectOptions.kind === 'screen'
        ? reconnectOptions.audio?.requested
        : true,
      audioMode,
      readyEvent.audio_port,
      mapReadyAudioMetadata(readyEvent),
    )
    session.stats = emptyStats()
    session.activeMethod = undefined
    session.publishedVideo = false
    session.publishedAudio = false
    session.audioFrames = undefined
    session.audioPackets = undefined
    session.audioPeakDb = undefined
    session.audioRmsDb = undefined
    session.videoFrames = undefined
    session.videoIntervalFrames = undefined
    session.videoLateFrames = undefined
    session.videoNoFrameCount = undefined
    session.videoRepeatedFrameCount = undefined
    session.videoRecoverableLostCount = undefined
    session.videoAvgCaptureUs = undefined
    session.videoAvgReadbackUs = undefined
    session.videoAvgScaleUs = undefined
    session.videoAvgPublishUs = undefined
    session.videoSourceWidth = undefined
    session.videoSourceHeight = undefined
    session.videoContentWidth = undefined
    session.videoContentHeight = undefined
    session.captureThreadMmcss = undefined
    session.helper = helper
    session.reconnectHelper = undefined
    session.reader = mediaEngineHelperReaders.get(helper)

    session.reconnecting = false
    return true
  } catch (error) {
    session.reconnectHelper = undefined
    session.reconnecting = false
    console.warn('[media-engine] sidecar reconnect failed', error)
    return false
  }
}

async function handleSidecarFailure(
  session: ActiveMediaEngineSession,
  reason: NativeMediaSidecarLostEvent['reason'],
  message: string,
) {
  const reconnected = await attemptSidecarReconnect(session)
  if (reconnected) return

  notifySidecarLost(session, reason, message)
  activeSessions.delete(session.sessionId)
  refreshStatusFromActiveSessions()
  lastMediaEngineError = message
  rejectPendingStop(session.sessionId, new Error(message))
  if (session.startOptions.kind === 'microphone') {
    prewarmNativeMediaEngineHelper()
  }
}

function handleHelperExit(
  helper: ChildProcessWithoutNullStreams,
  sessionId: string,
  code: number | null,
  signal: NodeJS.Signals | null,
) {
  const session = activeSessions.get(sessionId)
  if (!session) return
  if (!shouldHandleNativeMediaHelperExit(session, helper)) return

  const message =
    signal != null
      ? `Native media engine stopped (${signal})`
      : `Native media engine exited (${code ?? 'unknown'})`

  if (pendingStartResolvers.count(sessionId) > 0) {
    const startupMessage = buildNativeMediaStartupFailureMessage(
      message,
      startupDiagnostics.get(sessionId),
    )
    pendingStartResolvers.get(sessionId)?.({
      type: 'error',
      code: 'helper_exit',
      message: startupMessage,
    })
    pendingStartResolvers.delete(sessionId)
  }

  void handleSidecarFailure(session, 'exit', message)
}

function stopMediaEngineSession(sessionId: string, force = false) {
  const session = activeSessions.get(sessionId)
  if (!session) return false

  if (session.stopping) {
    if (!force) return true
    session.helper.kill()
    closeMediaEngineHelperReader(session.helper)
    activeSessions.delete(sessionId)
    resolvePendingStop(sessionId)
    refreshStatusFromActiveSessions()
    return true
  }

  const pendingStart = pendingStartResolvers.get(sessionId)
  if (pendingStart) {
    pendingStart({
      type: 'session_lifecycle',
      session_id: sessionId,
      kind: session.startOptions.kind,
      status: 'stopped',
      message: 'Native media engine start cancelled',
    })
    pendingStartResolvers.delete(sessionId)
  }

  const isMicrophone = session.startOptions.kind === 'microphone'
  const isPreparedScreen =
    session.startOptions.kind === 'screen' &&
    preconnectedScreenSession?.helper === session.helper
  const stopCommand =
    isMicrophone && !force
      ? 'disconnect_microphone'
      : isPreparedScreen && !force
        ? 'stop_screen_capture'
        : 'stop'
  const stopped = writeHelperCommand(session.helper, {
    cmd: stopCommand,
    sessionId,
  })
  const waitsForScreenStop =
    stopped && !force && session.startOptions.kind === 'screen'
  logNativeMediaDebugAgent({
    hypothesis: 'H4-native-stop-timeout',
    event: 'native-stop-requested',
    kind: session.startOptions.kind,
    force,
    stopCommand,
    helperWritable: stopped,
    waitsForScreenStop,
    isPreparedScreen,
  })
  if ((force || !stopped) && (!isPreparedScreen || force)) {
    session.helper.kill()
  } else if (!stopped && isPreparedScreen) {
    clearPreconnectedScreenSession(true)
  }
  if (!waitsForScreenStop) {
    closeMediaEngineHelperReader(session.helper)
  }
  if (waitsForScreenStop) {
    session.stopping = true
  } else {
    activeSessions.delete(sessionId)
  }
  if (isMicrophone && !force && stopped) {
    keepMicrophoneHelperWarmed(session.helper)
  }
  if (isPreparedScreen && force) {
    clearPreconnectedScreenSession(true)
  }

  refreshStatusFromActiveSessions()

  if (!stopped) {
    rejectPendingStop(sessionId, new Error('Native media helper is not writable'))
  }
  return stopped
}

function stopActiveMicrophoneSessions() {
  for (const session of Array.from(activeSessions.values())) {
    if (session.startOptions.kind === 'microphone') {
      const force = pendingStartResolvers.count(session.sessionId) > 0
      stopMediaEngineSession(session.sessionId, force)
    }
  }
}

function stopActiveScreenSessions() {
  for (const session of Array.from(activeSessions.values())) {
    if (session.startOptions.kind === 'screen') {
      stopMediaEngineSession(session.sessionId, true)
    }
  }
}

function cancelPendingMediaStarts(kind?: NativeMediaSessionKind) {
  if (kind) {
    latestStartRequestIds[kind] = crypto.randomUUID()
  } else {
    latestStartRequestIds = {}
  }
  for (const session of Array.from(activeSessions.values())) {
    if (kind && session.startOptions.kind !== kind) continue
    if (pendingStartResolvers.count(session.sessionId) === 0) continue
    stopMediaEngineSession(session.sessionId, true)
  }
}

function assertMediaStartRequestCurrent(options: NativeMediaSessionStartOptions) {
  if (latestStartRequestIds[options.kind] !== options.requestId) {
    throw new Error(`Native ${options.kind} start cancelled`)
  }
}

function stopMediaEngineHelper(force = false) {
  for (const sessionId of Array.from(activeSessions.keys())) {
    stopMediaEngineSession(sessionId, force)
  }
  clearPreconnectedScreenSession(force)
  pendingStartResolvers.clear()
  cancelPendingMediaStarts()
}

function stopMicrophonePreviewHelper() {
  if (!microphonePreviewHelper) return
  writeHelperCommand(microphonePreviewHelper, { cmd: 'stop' })
  microphonePreviewHelper.kill()
  microphonePreviewHelper = null
  microphonePreviewSessionId = null
}

function configureNativeMicrophoneRuntime(
  sessionId: string,
  config: NativeMicrophoneRuntimeConfig,
) {
  if (microphonePreviewHelper && microphonePreviewSessionId === sessionId) {
    const written = writeHelperCommand(microphonePreviewHelper, {
      cmd: 'configure',
      sessionId,
      ...config,
    })
    if (!written) {
      throw new Error('Native microphone preview helper is not writable')
    }
    return
  }

  const session = activeSessions.get(sessionId)
  if (session?.startOptions.kind === 'microphone') {
    const written = writeHelperCommand(session.helper, {
      cmd: 'configure',
      sessionId,
      ...config,
    })
    if (!written) {
      throw new Error('Native media helper is not writable')
    }
    session.effectiveMicrophoneConfig = {
      ...session.effectiveMicrophoneConfig,
      ...config,
    }
    return
  }

  const warmedHelper = prewarmedMediaEngineHelper
  if (
    sessionId === WARMED_MICROPHONE_SESSION_ID &&
    isHelperWritable(warmedHelper)
  ) {
    const helper = warmedHelper
    const written = writeHelperCommand(helper, {
      cmd: 'configure',
      sessionId,
      ...config,
    })
    if (!written) {
      throw new Error('Native microphone monitor helper is not writable')
    }
    return
  }

  if (sessionId === WARMED_MICROPHONE_SESSION_ID) {
    return
  }

  throw new Error('Native microphone runtime is not active')
}

function setNativeMicrophoneMuted(sessionId: string, muted: boolean) {
  const session = activeSessions.get(sessionId)
  if (session?.startOptions.kind !== 'microphone') {
    throw new Error('Native microphone runtime is not active')
  }

  const written = writeHelperCommand(session.helper, {
    cmd: 'set_microphone_muted',
    sessionId,
    muted,
  })
  if (!written) {
    throw new Error('Native media helper is not writable')
  }
  session.effectiveMuted = muted
}

async function reconnectNativeMicrophoneSession(
  getWindow: () => BrowserWindow | null,
  sessionId: string,
  options: NativeMediaMicrophoneSessionStartOptions,
): Promise<NativeMediaSession> {
  if (process.platform !== 'win32') {
    throw new Error('Native media engine is only available on Windows')
  }
  if (options.kind !== 'microphone') {
    throw new Error('Native microphone reconnect requires microphone options')
  }

  getWindowRef = getWindow
  const session = activeSessions.get(sessionId)
  if (!session || session.startOptions.kind !== 'microphone') {
    throw new Error('Native microphone runtime is not active')
  }
  if (!isHelperWritable(session.helper)) {
    throw new Error('Native media helper is not writable')
  }
  assertMediaStartRequestCurrent(options)

  const readyPromise = waitForSidecarReady(sessionId)
  const command = buildNativeMediaReconnectStartCommand(
    {
      startOptions: options,
      effectiveMicrophoneConfig: session.effectiveMicrophoneConfig,
      effectiveMuted: session.effectiveMuted,
    },
    sessionId,
    getWindow,
  )

  if (!writeHelperCommand(session.helper, command)) {
    pendingStartResolvers.delete(sessionId)
    throw new Error('Native media helper is not writable')
  }

  const readyEvent = await readyPromise
  assertMediaStartRequestCurrent(options)
  if (readyEvent.type !== 'ready') {
    throw new Error('Native microphone reconnect failed')
  }

  const audioMetadata = mapReadyAudioMetadata(readyEvent)
  const audio = buildSessionAudio(
    true,
    mapAudioMode(readyEvent.audio_mode),
    readyEvent.audio_port,
    audioMetadata,
  )
  if (!audio || audio.mode !== 'microphone') {
    throw new Error('Native microphone session did not reconnect')
  }

  session.startOptions = options
  session.port = undefined
  session.frameBufferPath = undefined
  session.width = readyEvent.width
  session.height = readyEvent.height
  session.fps = readyEvent.fps
  session.bitrate = readyEvent.bitrate
  session.audio = audio
  session.stats = emptyStats()
  session.activeMethod = undefined
  session.publishedVideo = false
  session.publishedAudio = false
  session.audioFrames = undefined
  session.audioPackets = undefined
  session.audioPeakDb = undefined
  session.audioRmsDb = undefined
  session.videoFrames = undefined
  session.videoIntervalFrames = undefined
  session.videoLateFrames = undefined
  session.videoNoFrameCount = undefined
  session.videoRepeatedFrameCount = undefined
  session.videoRecoverableLostCount = undefined
  session.videoAvgCaptureUs = undefined
  session.videoAvgReadbackUs = undefined
  session.videoAvgScaleUs = undefined
  session.videoAvgPublishUs = undefined
  session.videoSourceWidth = undefined
  session.videoSourceHeight = undefined
  session.videoContentWidth = undefined
  session.videoContentHeight = undefined
  session.captureThreadMmcss = undefined
  session.reconnectAttempts = 0

  return {
    kind: 'microphone',
    sessionId,
    audio: {
      mode: 'microphone',
      sampleRate: audioMetadata.sampleRate ?? 48_000,
      channels: 1,
      noiseSuppression: audioMetadata.noiseSuppression ?? 'disabled',
      echoCancellation: audioMetadata.echoCancellation ?? 'disabled',
    },
    nativeParticipantIdentity:
      readyEvent.native_participant_identity ??
      options.livekit.participantIdentity,
  }
}

async function startNativeMicrophonePreview(
  options: NativeMicrophonePreviewStartOptions,
): Promise<NativeMicrophonePreviewSession> {
  if (process.platform !== 'win32') {
    throw new Error('Native microphone preview is only available on Windows')
  }

  stopMicrophonePreviewHelper()

  const helperPath = resolveMediaEngineHelperPath('microphone')
  if (!helperPath) {
    throw new Error('Native microphone preview is not available')
  }

  const sessionId = crypto.randomUUID()
  const helper = spawn(helperPath, [], {
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  })
  const reader = readline.createInterface({ input: helper.stdout })
  microphonePreviewHelper = helper
  microphonePreviewSessionId = sessionId

  const ready = new Promise<NativeMicrophonePreviewSession>((resolve, reject) => {
    const timer = setTimeout(() => {
      stopMicrophonePreviewHelper()
      reject(new Error('Native microphone preview timed out'))
    }, 5_000)

    reader.on('line', (line) => {
      const event = parseSidecarEvent(line)
      if (!event) return
      if (event.type === 'error') {
        clearTimeout(timer)
        stopMicrophonePreviewHelper()
        reject(new Error(event.message))
        return
      }
      if (event.type === 'microphone_metrics') {
        if (getWindowRef) {
          emitMicrophoneMetrics(getWindowRef, mapMicrophoneMetrics(event))
        }
        return
      }
      if (event.type === 'microphone_diagnostics') {
        console.info('[microphone-preview-helper] diagnostics', event)
        return
      }
      if (event.type === 'ready') {
        clearTimeout(timer)
        resolve({ sessionId })
      }
    })

    helper.on('error', (error) => {
      clearTimeout(timer)
      stopMicrophonePreviewHelper()
      reject(error)
    })

    helper.on('exit', () => {
      if (microphonePreviewHelper === helper) {
        microphonePreviewHelper = null
        microphonePreviewSessionId = null
      }
    })
  })

  helper.stderr.on('data', (chunk) => {
    console.error('[microphone-preview-helper]', chunk.toString())
  })
  helper.stdin.on('error', (error) => {
    if ((error as NodeJS.ErrnoException).code === 'EPIPE') return
    console.error('[microphone-preview-helper] stdin error', error)
  })

  if (
    !writeHelperCommand(helper, {
      cmd: 'start_preview',
      sessionId,
      deviceId: options.deviceId,
      sampleRate: options.sampleRate,
      channels: options.channels,
      noiseSuppression: options.noiseSuppression,
      echoCancellation: options.echoCancellation,
      inputVolume: options.inputVolume,
      voiceGateEnabled: options.voiceGateEnabled,
      voiceGateThresholdDb: options.voiceGateThresholdDb,
      voiceGateAutoThreshold: options.voiceGateAutoThreshold,
    })
  ) {
    stopMicrophonePreviewHelper()
    throw new Error('Native microphone preview helper is not writable')
  }

  return ready
}

function spawnMediaEngineHelper(
  kind: NativeMediaSessionStartOptions['kind'],
  sessionId: string,
  existingHelper?: ChildProcessWithoutNullStreams,
) {
  const helper =
    existingHelper ??
    (kind === 'microphone'
      ? takePrewarmedMediaEngineHelper() ?? spawnNativeMediaEngineProcess(kind)
      : spawnNativeMediaEngineProcess(kind))

  const existingReader = mediaEngineHelperReaders.get(helper)
  if (existingReader) {
    if (!existingHelper) return helper
    closeMediaEngineHelperReader(helper)
  }

  const reader = readline.createInterface({ input: helper.stdout })
  mediaEngineHelperReaders.set(helper, reader)
  reader.on('line', (line) => {
    const event = parseSidecarEvent(line)
    if (!event) return
    const eventSessionId = eventSessionIdForHelper(helper, sessionId, event)
    const session = activeSessions.get(eventSessionId)

    if (event.type === 'session_lifecycle') {
      recordNativeMediaStartupLifecycle(event)
      console.info('[media-engine-helper] lifecycle', event)
      logNativeMediaDebugAgent({
        hypothesis: 'H1-screen-start-lifecycle',
        event: 'native-lifecycle',
        kind: session?.startOptions.kind ?? 'unknown',
        status: event.status,
        message: event.message,
        hasSession: Boolean(session),
        helperPid: helper.pid,
        elapsedMs: session ? Date.now() - session.debugStartedAtMs : undefined,
      })
      if (event.status === 'stopped') {
        resolvePendingStop(event.session_id)
        activeSessions.delete(event.session_id)
        pendingStartResolvers.get(event.session_id)?.(event)
        pendingStartResolvers.delete(event.session_id)
        closeIdleMediaEngineHelperReader(helper)
        refreshStatusFromActiveSessions()
        return
      }
      if (getWindowRef) {
        emitMediaEngineState(getWindowRef, mapLifecycleState(event))
      } else {
        mediaEngineStatus = mapLifecycleState(event)
        if (mediaEngineStatus.status === 'error') {
          lastMediaEngineError = mediaEngineStatus.message
        }
      }

      if (event.status === 'error') {
        rejectPendingStop(
          event.session_id,
          new Error(event.message ?? 'Native media engine failed'),
        )
        pendingStartResolvers.get(event.session_id)?.(event)
        pendingStartResolvers.delete(event.session_id)
      } else {
        pendingStartResolvers.get(event.session_id)?.(event)
      }
      return
    }

    if (event.type === 'screen_capture_ended') {
      const endedSession = activeSessions.get(event.session_id)
      console.info('[media-engine-helper] screen capture ended', event)
      if (getWindowRef) {
        const win = getWindowRef()
        if (win && !win.isDestroyed()) {
          win.webContents.send(IPC.mediaStreamEnded, event.session_id)
        }
      }
      if (endedSession?.startOptions.kind === 'screen') {
        const stopped = writeHelperCommand(endedSession.helper, {
          cmd: 'stop_screen_capture',
          sessionId: event.session_id,
        })
        if (!stopped) {
          stopMediaEngineSession(event.session_id, true)
        }
      }
      return
    }

    if (event.type === 'frame_method' && session) {
      const method = mapFrameMethod(event.method)
      const activeMethod = mapFrameMethod(event.active_method ?? event.method)
      if (method) {
        session.stats[method] = event.count
      }
      if (activeMethod) {
        session.activeMethod = activeMethod
      }
      if (getWindowRef) {
        emitMediaEngineStats(getWindowRef, buildMediaEngineStatsEvent(session))
      }
      return
    }

    if (event.type === 'microphone_metrics' && getWindowRef) {
      emitMicrophoneMetrics(getWindowRef, mapMicrophoneMetrics(event))
      return
    }

    if (event.type === 'microphone_diagnostics') {
      if (
        !session &&
        reconcileUnownedMediaEngineHelperEvent(
          helper,
          'microphone-diagnostics-without-session',
        )
      ) {
        return
      }
      console.info('[media-engine-helper] microphone diagnostics', event)
      logNativeMediaDebugAgent({
        hypothesis: 'H4-audio-frame-gaps',
        event: 'native-microphone-diagnostics',
        kind: session?.startOptions.kind ?? 'unknown',
        helperPid: helper.pid,
        elapsedMs: session ? Date.now() - session.debugStartedAtMs : undefined,
        intervalFrames: event.interval_frames,
        maxFrameGapMs: event.max_frame_gap_ms,
        maxCaptureFrameUs: event.max_capture_frame_us,
        gatedFrames: event.gated_frames,
        clippedSamples: event.clipped_samples,
        inputDb: event.input_db,
        outputPeak: event.output_peak,
      })
      return
    }

    if (event.type === 'track_published') {
      const publishedSession = activeSessions.get(event.session_id)
      if (publishedSession) {
        if (event.kind === 'video') publishedSession.publishedVideo = true
        if (event.kind === 'audio') {
          publishedSession.publishedAudio = true
          publishedSession.audio = buildSessionAudio(
            publishedSession.startOptions.kind === 'screen'
              ? publishedSession.startOptions.audio?.requested
              : true,
            mapAudioMode(event.audio_mode),
            undefined,
            mapSidecarAudioMetadata(event),
          )
        }
        if (getWindowRef) {
          emitMediaEngineStats(getWindowRef, buildMediaEngineStatsEvent(publishedSession))
        }
      }
      console.info(
        '[media-engine-helper] track published',
        event,
      )
      logNativeMediaDebugAgent({
        hypothesis: 'H1-screen-start-lifecycle,H3-remote-decode-lag',
        event: 'native-track-published',
        sessionKind: publishedSession?.startOptions.kind ?? 'unknown',
        trackKind: event.kind,
        audioMode: event.audio_mode,
        elapsedMs: publishedSession
          ? Date.now() - publishedSession.debugStartedAtMs
          : undefined,
      })
      return
    }

    if (event.type === 'track_unpublished') {
      console.info('[media-engine-helper] track unpublished', event)
      return
    }

    if (event.type === 'screen_audio_frame') {
      const audioSession = activeSessions.get(event.session_id)
      if (audioSession) {
        audioSession.audioFrames = event.frames
        audioSession.audioPackets = event.packets
        audioSession.audioPeakDb = event.peak_db
        audioSession.audioRmsDb = event.rms_db
        audioSession.audio = buildSessionAudio(
          audioSession.startOptions.kind === 'screen'
            ? audioSession.startOptions.audio?.requested
            : true,
          mapAudioMode(event.audio_mode),
          undefined,
          mapSidecarAudioMetadata({
            audio_sample_rate: event.sample_rate,
            audio_channels: event.channels,
            audio_target_process_id: event.audio_target_process_id,
            audio_loopback_mode: event.audio_loopback_mode,
          }),
        )
        if (getWindowRef) {
          emitMediaEngineStats(getWindowRef, buildMediaEngineStatsEvent(audioSession))
        }
      }
      console.info('[media-engine-helper] screen audio diagnostics', event)
      logNativeMediaDebugAgent({
        hypothesis: 'H4-audio-frame-gaps',
        event: 'native-screen-audio-frame',
        elapsedMs: audioSession
          ? Date.now() - audioSession.debugStartedAtMs
          : undefined,
        frames: event.frames,
        packets: event.packets,
        sampleRate: event.sample_rate,
        channels: event.channels,
        audioMode: event.audio_mode,
        peakDb: event.peak_db,
        rmsDb: event.rms_db,
      })
      return
    }

    if (event.type === 'screen_video_frame') {
      const videoSession = activeSessions.get(event.session_id)
      if (videoSession) {
        const method = event.method ? mapFrameMethod(event.method) : null
        if (method) {
          videoSession.stats[method] = event.frames
          videoSession.activeMethod = method
        }
        videoSession.videoFrames = event.frames
        videoSession.videoIntervalFrames = event.interval_frames
        videoSession.videoLateFrames = event.late_frames
        videoSession.videoNoFrameCount = event.no_frame_count
        videoSession.videoRepeatedFrameCount = event.repeated_frame_count
        videoSession.videoRecoverableLostCount = event.recoverable_lost_count
        videoSession.videoAvgCaptureUs = event.avg_capture_us
        videoSession.videoAvgReadbackUs = event.avg_readback_us
        videoSession.videoAvgScaleUs = event.avg_scale_us
        videoSession.videoAvgPublishUs = event.avg_publish_us
        videoSession.videoSourceWidth = event.source_width
        videoSession.videoSourceHeight = event.source_height
        videoSession.videoContentWidth = event.content_width
        videoSession.videoContentHeight = event.content_height
        videoSession.captureThreadMmcss = event.capture_thread_mmcss
        if (getWindowRef) {
          emitMediaEngineStats(getWindowRef, buildMediaEngineStatsEvent(videoSession))
        }
      }
      console.info('[media-engine-helper] screen video diagnostics', event)
      logNativeMediaDebugAgent({
        hypothesis: 'H2-bitrate-ramp,H3-remote-decode-lag',
        event: 'native-screen-video-frame',
        elapsedMs: videoSession
          ? Date.now() - videoSession.debugStartedAtMs
          : undefined,
        frames: event.frames,
        intervalFrames: event.interval_frames,
        targetFps: event.target_fps,
        lateFrames: event.late_frames,
        noFrameCount: event.no_frame_count,
        repeatedFrameCount: event.repeated_frame_count,
        recoverableLostCount: event.recoverable_lost_count,
        avgCaptureUs: event.avg_capture_us,
        avgReadbackUs: event.avg_readback_us,
        avgScaleUs: event.avg_scale_us,
        avgPublishUs: event.avg_publish_us,
        sourceWidth: event.source_width,
        sourceHeight: event.source_height,
        contentWidth: event.content_width,
        contentHeight: event.content_height,
        captureThreadMmcss: event.capture_thread_mmcss,
      })
      return
    }

    if (event.type === 'downgrade') {
      console.warn(
        '[media-engine-helper] downgrade',
        event.from,
        '->',
        event.to,
        event.reason,
      )
      return
    }

    if (event.type === 'error') {
      recordNativeMediaStartupStderr(eventSessionId, event.message)
      const errorState: NativeMediaStateEvent = {
        status: 'error',
        sessionId: eventSessionId,
        message: event.message,
      }
      if (getWindowRef) {
        emitMediaEngineState(getWindowRef, errorState)
      } else {
        mediaEngineStatus = errorState
        lastMediaEngineError = event.message
      }
      pendingStartResolvers.get(eventSessionId)?.(event)
      pendingStartResolvers.delete(eventSessionId)
      rejectPendingStop(eventSessionId, new Error(event.message))
      return
    }

    if (event.type === 'stopped') {
      activeSessions.delete(sessionId)
      rejectPendingStop(sessionId, new Error('Native media engine stopped'))
      refreshStatusFromActiveSessions()
      return
    }

    pendingStartResolvers.get(eventSessionId)?.(event)
    pendingStartResolvers.delete(eventSessionId)
  })

  helper.stderr.on('data', (chunk) => {
    const text = chunk.toString()
    recordNativeMediaHelperStderr(helper, sessionId, text)
    console.error('[media-engine-helper]', text)
  })
  helper.stdin.on('error', (error) => {
    if ((error as NodeJS.ErrnoException).code === 'EPIPE') return
    console.error('[media-engine-helper] stdin error', error)
  })

  helper.on('exit', (code, signal) => {
    const sessions = Array.from(activeSessions.values()).filter(
      (session) => session.helper === helper,
    )
    if (sessions.length > 0) {
      for (const session of sessions) {
        handleHelperExit(helper, session.sessionId, code, signal)
      }
    } else if (activeSessions.has(sessionId)) {
      handleHelperExit(helper, sessionId, code, signal)
    }
    if (preconnectedScreenSession?.helper === helper) {
      preconnectedScreenSession = null
    }
    closeMediaEngineHelperReader(helper)
    if (activeSessions.size === 0) {
      mediaEngineStatus = { status: 'idle' }
    }
  })

  return helper
}

async function listNativeMediaDevices(
  kind: 'audioinput',
): Promise<NativeMediaDeviceInfo[]> {
  if (process.platform !== 'win32' || kind !== 'audioinput') return []

  const helperPath = resolveMediaEngineHelperPath('microphone')
  if (!helperPath) return []

  return new Promise((resolve, reject) => {
    const helper = spawn(helperPath, [], {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    })
    const reader = readline.createInterface({ input: helper.stdout })
    let settled = false

    const finish = (devices: NativeMediaDeviceInfo[]) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      reader.close()
      helper.kill()
      resolve(devices)
    }
    const fail = (error: Error) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      reader.close()
      helper.kill()
      reject(error)
    }
    const timer = setTimeout(() => {
      fail(new Error('Native media device enumeration timed out'))
    }, 5_000)

    reader.on('line', (line) => {
      const event = parseSidecarEvent(line)
      if (!event) return
      if (event.type === 'device_list') {
        finish(event.devices.filter((device) => device.kind === kind))
      } else if (event.type === 'error') {
        fail(new Error(event.message))
      }
    })
    helper.on('error', fail)
    helper.on('exit', () => {
      if (!settled) finish([])
    })
    helper.stdin.on('error', (error) => {
      if ((error as NodeJS.ErrnoException).code === 'EPIPE') {
        finish([])
        return
      }
      fail(error)
    })
    if (!writeHelperCommand(helper, { cmd: 'list_devices', kind })) {
      finish([])
    }
  })
}

async function runNativeScreenSharePreflight(
  options: Extract<NativeMediaSessionStartOptions, { kind: 'screen' }>,
  getWindow: () => BrowserWindow | null,
) {
  const helperPath = resolveMediaEngineHelperPath('screen')
  if (!helperPath) {
    throw new Error('Native screen capture is not available')
  }

  return new Promise<Extract<SidecarEvent, { type: 'screen_share_preflight' }>>(
    (resolve, reject) => {
      const helper = spawn(helperPath, [], {
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
      })
      const reader = readline.createInterface({ input: helper.stdout })
      let settled = false

      const finish = (
        event: Extract<SidecarEvent, { type: 'screen_share_preflight' }>,
      ) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        reader.close()
        helper.kill()
        if (!event.ok) {
          reject(new Error(event.message ?? 'Native screen share preflight failed'))
          return
        }
        resolve(event)
      }
      const fail = (error: Error) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        reader.close()
        helper.kill()
        reject(error)
      }
      const timer = setTimeout(() => {
        fail(new Error('Native screen share preflight timed out'))
      }, 7_500)

      reader.on('line', (line) => {
        const event = parseSidecarEvent(line)
        if (!event) return
        if (event.type === 'screen_share_preflight') {
          finish(event)
        } else if (event.type === 'error') {
          fail(new Error(event.message))
        }
      })
      helper.on('error', fail)
      helper.on('exit', () => {
        if (!settled) fail(new Error('Native screen share preflight exited'))
      })
      helper.stdin.on('error', (error) => {
        if ((error as NodeJS.ErrnoException).code === 'EPIPE') {
          fail(new Error('Native screen share preflight pipe closed'))
          return
        }
        fail(error)
      })
      if (!writeHelperCommand(helper, buildScreenSharePreflightCommand(options, getWindow))) {
        fail(new Error('Native screen share preflight helper is not writable'))
      }
    },
  )
}

export async function listNativeDisplaySources(
  getWindow?: () => BrowserWindow | null,
): Promise<DesktopDisplayMediaSource[]> {
  if (process.platform !== 'win32') return []

  const helperPath = resolveMediaEngineHelperPath('screen')
  if (!helperPath) return []

  return new Promise((resolve, reject) => {
    const helper = spawn(helperPath, [], {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    })
    const reader = readline.createInterface({ input: helper.stdout })
    let settled = false

    const finish = (sources: DesktopDisplayMediaSource[]) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      reader.close()
      helper.kill()
      resolve(sources)
    }
    const fail = (error: Error) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      reader.close()
      helper.kill()
      reject(error)
    }
    const timer = setTimeout(() => {
      fail(new Error('Native display source enumeration timed out'))
    }, 5_000)

    reader.on('line', (line) => {
      const event = parseSidecarEvent(line)
      if (!event) return
      if (event.type === 'display_source_list') {
        finish(event.sources)
      } else if (event.type === 'error') {
        fail(new Error(event.message))
      }
    })
    helper.on('error', fail)
    helper.on('exit', () => {
      if (!settled) finish([])
    })
    helper.stdin.on('error', (error) => {
      if ((error as NodeJS.ErrnoException).code === 'EPIPE') {
        finish([])
        return
      }
      fail(error)
    })
    const win = getWindow?.()
    const selfWindowHwnd =
      win && !win.isDestroyed() ? readWindowHwnd(win) : undefined
    if (!writeHelperCommand(helper, { cmd: 'list_screen_sources', selfWindowHwnd })) {
      finish([])
    }
  })
}

async function waitForSidecarReady(sessionId: string, timeoutMs = 15_000) {
  return new Promise<SidecarEvent>((resolve, reject) => {
    let removeResolver = () => {}
    let timer: ReturnType<typeof setTimeout> | null = null
    let settled = false
    const cleanup = () => {
      if (timer) {
        clearTimeout(timer)
        timer = null
      }
      removeResolver()
      startupDiagnostics.delete(sessionId)
    }
    const fail = (error: Error) => {
      if (settled) return
      settled = true
      cleanup()
      reject(error)
    }
    const resetTimer = () => {
      if (settled) return
      if (timer) clearTimeout(timer)
      timer = setTimeout(() => {
        const message = buildNativeMediaStartupTimeoutMessage(
          startupDiagnostics.get(sessionId),
        )
        lastMediaEngineError = message
        fail(new Error(message))
      }, timeoutMs)
    }

    resetTimer()

    removeResolver = pendingStartResolvers.set(sessionId, (event) => {
      if (event.type === 'session_lifecycle') {
        if (event.status === 'error') {
          fail(new Error(event.message ?? 'Native media engine failed to start'))
          return
        }
        if (event.status === 'stopped') {
          fail(new Error(event.message ?? 'Native media engine stopped before it became ready'))
          return
        }
        resetTimer()
        return
      }
      if (event.type === 'error') {
        fail(new Error(event.message))
        return
      }
      settled = true
      cleanup()
      resolve(event)
    })
  })
}

function resolvePendingStop(sessionId: string) {
  const pending = pendingStopResolvers.get(sessionId)
  if (!pending) return
  pendingStopResolvers.delete(sessionId)
  clearTimeout(pending.timeout)
  pending.resolve()
}

function rejectPendingStop(sessionId: string, error: Error) {
  const pending = pendingStopResolvers.get(sessionId)
  if (!pending) return
  pendingStopResolvers.delete(sessionId)
  clearTimeout(pending.timeout)
  pending.reject(error)
}

async function waitForMediaEngineSessionStopped(sessionId: string) {
  const existing = pendingStopResolvers.get(sessionId)
  if (existing) return existing.wait

  let resolveStop!: () => void
  let rejectStop!: (error: Error) => void
  const wait = new Promise<void>((resolve, reject) => {
    resolveStop = resolve
    rejectStop = reject
  })
  const timeout = setTimeout(() => {
    pendingStopResolvers.delete(sessionId)
    logNativeMediaDebugAgent({
      hypothesis: 'H4-native-stop-timeout',
      event: 'native-stop-timeout-force-kill',
    })
    stopMediaEngineSession(sessionId, true)
    rejectStop(new Error('Native media engine stop timed out'))
  }, NATIVE_MEDIA_STOP_TIMEOUT_MS)

  pendingStopResolvers.set(sessionId, {
    resolve: resolveStop,
    reject: rejectStop,
    timeout,
    wait,
  })
  return wait
}

async function prepareNativeScreenSession(
  getWindow: () => BrowserWindow | null,
  options: NativeMediaScreenSessionPrepareOptions,
) {
  if (process.platform !== 'win32') return
  getWindowRef = getWindow

  const livekitKey = nativeScreenLiveKitKey(options.livekit)
  const current = preconnectedScreenSession
  if (current && current.livekitKey === livekitKey && isHelperWritable(current.helper)) {
    await current.ready
    return
  }

  clearPreconnectedScreenSession(true)

  const sessionId = crypto.randomUUID()
  const helper = spawnMediaEngineHelper('screen', sessionId)
  const ready = waitForSidecarReady(sessionId).then((event) => {
    if (event.type !== 'ready') {
      throw new Error('Native screen session did not preconnect')
    }
  })

  preconnectedScreenSession = {
    sessionId,
    helper,
    livekitKey,
    ready,
  }

  if (
    !writeHelperCommand(helper, {
      cmd: 'connect_screen',
      sessionId,
      sessionKind: 'screen',
      url: options.livekit.url,
      token: options.livekit.token,
      participantIdentity: options.livekit.participantIdentity,
      livekit: options.livekit,
    })
  ) {
    clearPreconnectedScreenSession(true)
    throw new Error('Native screen helper is not writable')
  }

  try {
    await ready
  } catch (error) {
    clearPreconnectedScreenSession(true)
    throw error
  }
}

async function takePreconnectedScreenHelper(
  livekit: NativeMediaLiveKitCredentials,
) {
  const current = preconnectedScreenSession
  if (!current) return null
  if (current.livekitKey !== nativeScreenLiveKitKey(livekit)) {
    clearPreconnectedScreenSession(true)
    return null
  }
  if (!isHelperWritable(current.helper)) {
    closeMediaEngineHelperReader(current.helper)
    preconnectedScreenSession = null
    return null
  }
  await current.ready
  if (preconnectedScreenSession === current) {
    preconnectedScreenSession = null
  }
  return current.helper
}

function mapSidecarAudioMetadata(event: {
  audio_sample_rate?: number
  audio_channels?: number
  noise_suppression?: string
  echo_cancellation?: string
  audio_target_process_id?: number
  audio_loopback_mode?: string
}) {
  return {
    sampleRate: event.audio_sample_rate === 48_000 ? 48_000 : undefined,
    channels:
      event.audio_channels === 1 || event.audio_channels === 2
        ? event.audio_channels
        : undefined,
    noiseSuppression: mapNoiseSuppressionMode(event.noise_suppression),
    echoCancellation: mapEchoCancellationMode(event.echo_cancellation),
    targetProcessId:
      typeof event.audio_target_process_id === 'number'
        ? event.audio_target_process_id
        : undefined,
    loopbackMode: mapLoopbackMode(event.audio_loopback_mode),
  } satisfies {
    sampleRate?: 48_000
    channels?: 1 | 2
    noiseSuppression?: NativeMediaNoiseSuppressionMode
    echoCancellation?: NativeMediaEchoCancellationMode
    targetProcessId?: number
    loopbackMode?: import('@syrnike13/platform').NativeMediaLoopbackMode
  }
}

function mapReadyAudioMetadata(readyEvent: Extract<SidecarEvent, { type: 'ready' }>) {
  return mapSidecarAudioMetadata(readyEvent)
}

async function startNativeMediaSession(
  getWindow: () => BrowserWindow | null,
  options: NativeMediaSessionStartOptions,
): Promise<NativeMediaSession> {
  if (process.platform !== 'win32') {
    throw new Error('Native media engine is only available on Windows')
  }

  getWindowRef = getWindow
  assertMediaStartRequestCurrent(options)
  const debugStartRequestedAtMs = Date.now()
  logNativeMediaDebugAgent({
    hypothesis: 'H1-screen-start-lifecycle,H4-audio-frame-gaps',
    event: 'native-start-requested',
    kind: options.kind,
    width: options.kind === 'screen' ? options.width : undefined,
    height: options.kind === 'screen' ? options.height : undefined,
    fps: options.kind === 'screen' ? options.fps : undefined,
    bitrate: options.kind === 'screen' ? options.bitrate : undefined,
    audioRequested:
      options.kind === 'screen' ? options.audio?.requested : true,
  })

  if (options.kind === 'microphone') {
    stopActiveMicrophoneSessions()
  }

  const sessionId = crypto.randomUUID()
  const preparedScreenHelper =
    options.kind === 'screen'
      ? await takePreconnectedScreenHelper(options.livekit)
      : null
  logNativeMediaDebugAgent({
    hypothesis: 'H1-screen-start-lifecycle',
    event: 'native-helper-selected',
    kind: options.kind,
    elapsedMs: Date.now() - debugStartRequestedAtMs,
    usedPreconnectedHelper: Boolean(preparedScreenHelper),
  })
  assertMediaStartRequestCurrent(options)
  const helper = spawnMediaEngineHelper(
    options.kind,
    sessionId,
    preparedScreenHelper ?? undefined,
  )
  const session: ActiveMediaEngineSession = {
    sessionId,
    debugStartedAtMs: Date.now(),
    port: undefined,
    width: undefined,
    height: undefined,
    fps: undefined,
    bitrate: undefined,
    audio: undefined,
    frameBufferPath: undefined,
    helper,
    stats: emptyStats(),
    publishedVideo: false,
    publishedAudio: false,
    audioFrames: undefined,
    audioPackets: undefined,
    audioPeakDb: undefined,
    audioRmsDb: undefined,
    videoFrames: undefined,
    videoIntervalFrames: undefined,
    videoLateFrames: undefined,
    videoNoFrameCount: undefined,
    videoRepeatedFrameCount: undefined,
    videoRecoverableLostCount: undefined,
    videoAvgCaptureUs: undefined,
    videoAvgReadbackUs: undefined,
    videoAvgScaleUs: undefined,
    videoAvgPublishUs: undefined,
    videoSourceWidth: undefined,
    videoSourceHeight: undefined,
    videoContentWidth: undefined,
    videoContentHeight: undefined,
    captureThreadMmcss: undefined,
    startOptions: options,
    reconnectAttempts: 0,
    reconnecting: false,
    stopping: false,
    reader: mediaEngineHelperReaders.get(helper),
  }
  activeSessions.set(sessionId, session)
  activeSession = options.kind === 'screen' || !activeSession ? session : activeSession

  const readyPromise = waitForSidecarReady(sessionId)
  const startCommand = buildNativeMediaStartCommand(options, sessionId, getWindow)

  if (!writeHelperCommand(helper, startCommand)) {
    stopMediaEngineSession(sessionId, true)
    throw new Error('Native media helper is not writable')
  }
  logNativeMediaDebugAgent({
    hypothesis: 'H1-screen-start-lifecycle',
    event: 'native-start-command-sent',
    kind: options.kind,
    elapsedMs: Date.now() - debugStartRequestedAtMs,
  })
  let readyEvent: SidecarEvent
  try {
    readyEvent = await readyPromise
  } catch (error) {
    stopMediaEngineSession(sessionId, true)
    emitMediaEngineState(getWindow, {
      status: 'error',
      sessionId,
      message:
        error instanceof Error
          ? error.message
          : 'Native media engine failed to start',
    })
    throw error
  }
  if (readyEvent.type !== 'ready') {
    stopMediaEngineSession(sessionId, true)
    throw new Error('Native media engine failed to start')
  }
  logNativeMediaDebugAgent({
    hypothesis: 'H1-screen-start-lifecycle,H4-audio-frame-gaps',
    event: 'native-ready',
    kind: options.kind,
    elapsedMs: Date.now() - debugStartRequestedAtMs,
    width: readyEvent.width,
    height: readyEvent.height,
    fps: readyEvent.fps,
    bitrate: readyEvent.bitrate,
    audioMode: readyEvent.audio_mode,
    hasAudioPort: readyEvent.audio_port != null,
    encoder: readyEvent.encoder,
  })

  const audioMode = mapAudioMode(readyEvent.audio_mode)
  const audioMetadata = mapReadyAudioMetadata(readyEvent)
  const audio = buildSessionAudio(
    options.kind === 'screen' ? options.audio?.requested : true,
    audioMode,
    readyEvent.audio_port,
    audioMetadata,
  )
  session.port = options.kind === 'screen' ? readyEvent.port : undefined
  session.width = readyEvent.width
  session.height = readyEvent.height
  session.fps = readyEvent.fps
  session.bitrate = readyEvent.bitrate
  session.audio = audio
  session.frameBufferPath = readyEvent.frame_buffer_path

  if (options.kind === 'microphone') {
    if (!audio || audio.mode !== 'microphone') {
      stopMediaEngineSession(sessionId, true)
      throw new Error('Native microphone session did not start')
    }
    return {
      kind: 'microphone',
      sessionId,
      audio: {
        mode: 'microphone',
        sampleRate: audioMetadata.sampleRate ?? 48_000,
        channels: 1,
        noiseSuppression: audioMetadata.noiseSuppression ?? 'disabled',
        echoCancellation: audioMetadata.echoCancellation ?? 'disabled',
      },
      nativeParticipantIdentity:
        readyEvent.native_participant_identity ??
        options.livekit.participantIdentity,
    }
  }

  const encoder = mapEncoderBackend(readyEvent.encoder)

  if (audio?.mode === 'microphone') {
    stopMediaEngineSession(sessionId, true)
    throw new Error('Native screen session reported microphone audio')
  }
  const screenAudio = audio ?
    {
      mode: audio.mode as NativeMediaScreenAudioMode,
      port: audio.port,
      targetProcessId: audio.targetProcessId,
      loopbackMode: audio.loopbackMode,
    }
  : undefined

  const screenSession: NativeMediaSession = {
    kind: 'screen',
    sessionId,
    port: readyEvent.port || undefined,
    encoder,
    width: readyEvent.width,
    height: readyEvent.height,
    fps: readyEvent.fps,
    bitrate: readyEvent.bitrate,
    audio: screenAudio,
    nativeParticipantIdentity: readyEvent.native_participant_identity,
  }

  return screenSession
}

export function registerNativeMediaEngineIpc(getWindow: () => BrowserWindow | null) {
  if (mediaEngineIpcRegistered) return
  mediaEngineIpcRegistered = true
  getWindowRef = getWindow

  ipcMain.handle(
    IPC.mediaPrepareScreenSession,
    async (event, options: NativeMediaScreenSessionPrepareOptions) => {
      if (!isTrustedSender(event, getWindow)) {
        throw new Error('Untrusted media engine prepare request')
      }
      const prepare = startSessionQueues.screen.then(() =>
        prepareNativeScreenSession(getWindow, options),
      )
      startSessionQueues.screen = prepare.catch(() => undefined)
      return prepare
    },
  )

  ipcMain.handle(IPC.mediaDisconnectPreparedScreenSession, async (event) => {
    if (!isTrustedSender(event, getWindow)) return
    cancelPendingMediaStarts('screen')
    clearPreconnectedScreenSession(false)
  })

  ipcMain.handle(
    IPC.mediaStartSession,
    async (event, options: NativeMediaSessionStartOptions) => {
      if (!isTrustedSender(event, getWindow)) {
        throw new Error('Untrusted media engine start request')
      }
      cancelPendingMediaStarts(options.kind)
      latestStartRequestIds[options.kind] = options.requestId
      if (options.kind === 'microphone') {
        stopActiveMicrophoneSessions()
      } else {
        stopActiveScreenSessions()
      }
      const start = startSessionQueues[options.kind].then(() => {
        assertMediaStartRequestCurrent(options)
        return startNativeMediaSession(getWindow, options)
      })
      startSessionQueues[options.kind] = start.catch(() => undefined)
      return start
    },
  )

  ipcMain.handle(
    IPC.mediaCancelPendingStarts,
    async (event, kind?: NativeMediaSessionKind) => {
      if (!isTrustedSender(event, getWindow)) return
      cancelPendingMediaStarts(kind)
    },
  )

  ipcMain.handle(IPC.mediaStopSession, async (event, sessionId?: string) => {
    if (!isTrustedSender(event, getWindow)) return
    if (sessionId) {
      const session = activeSessions.get(sessionId)
      const stopPromise =
        session?.startOptions.kind === 'screen'
          ? waitForMediaEngineSessionStopped(sessionId)
          : Promise.resolve()
      if (!stopMediaEngineSession(sessionId)) {
        throw new Error('Native media session is not active')
      }
      await stopPromise
      return
    }
    stopMediaEngineHelper()
  })

  ipcMain.handle(
    IPC.mediaConfigureMicrophoneRuntime,
    async (
      event,
      sessionId: string,
      config: NativeMicrophoneRuntimeConfig,
    ) => {
      if (!isTrustedSender(event, getWindow)) {
        throw new Error('Untrusted media engine configure request')
      }
      configureNativeMicrophoneRuntime(sessionId, config)
    },
  )

  ipcMain.handle(
    IPC.mediaSetMicrophoneMuted,
    async (event, sessionId: string, muted: boolean) => {
      if (!isTrustedSender(event, getWindow)) {
        throw new Error('Untrusted media engine mute request')
      }
      setNativeMicrophoneMuted(sessionId, Boolean(muted))
    },
  )

  ipcMain.handle(
    IPC.mediaReconnectMicrophoneSession,
    async (
      event,
      sessionId: string,
      options: NativeMediaMicrophoneSessionStartOptions,
    ) => {
      if (!isTrustedSender(event, getWindow)) {
        throw new Error('Untrusted media engine reconnect request')
      }
      latestStartRequestIds.microphone = options.requestId
      const reconnect = startSessionQueues.microphone.then(() => {
        assertMediaStartRequestCurrent(options)
        return reconnectNativeMicrophoneSession(getWindow, sessionId, options)
      })
      startSessionQueues.microphone = reconnect.catch(() => undefined)
      return reconnect
    },
  )

  ipcMain.handle(IPC.mediaListDevices, async (event, kind: 'audioinput') => {
    if (!isTrustedSender(event, getWindow)) return []
    return listNativeMediaDevices(kind)
  })

  ipcMain.handle(
    IPC.mediaStartMicrophonePreview,
    async (event, options: NativeMicrophonePreviewStartOptions) => {
      if (!isTrustedSender(event, getWindow)) {
        throw new Error('Untrusted microphone preview start request')
      }
      return startNativeMicrophonePreview(options)
    },
  )

  ipcMain.handle(
    IPC.mediaStopMicrophonePreview,
    async (event, sessionId?: string) => {
      if (!isTrustedSender(event, getWindow)) return
      if (sessionId && microphonePreviewSessionId !== sessionId) return
      stopMicrophonePreviewHelper()
    },
  )

  ipcMain.handle(IPC.mediaGetState, async (event) => {
    if (!isTrustedSender(event, getWindow)) {
      return buildNativeMediaEngineSnapshot({
        platform: process.platform,
        helperAvailable: false,
        helperRunning: false,
        activeSession: null,
        lastError: null,
      })
    }
    return getNativeMediaEngineState()
  })

  ipcMain.handle(
    IPC.mediaOpenDisplayPicker,
    async (event, audioRequested: boolean) => {
      if (!isTrustedSender(event, getWindow)) {
        throw new Error('Untrusted native picker request')
      }
      if (!resolveMediaEngineHelperPath('screen')) {
        throw new Error('Native screen capture is not available')
      }

      const win = getWindow()
      if (!win || win.isDestroyed()) {
        throw new Error('Desktop window is not available')
      }

      clearPendingNativePicker()

      const request: DesktopDisplayMediaRequest = {
        id: crypto.randomUUID(),
        audioRequested: Boolean(audioRequested),
        nativeVideo: true,
      }

      pendingNativePicker = {
        id: request.id,
        audioRequested: request.audioRequested,
        sources: [],
        timeout: setTimeout(clearPendingNativePicker, NATIVE_PICKER_TIMEOUT_MS),
      }

      win.webContents.send(IPC.mediaRequest, request)
      return request
    },
  )
}

export function getActiveMediaEngineStats() {
  return activeSession
    ? {
        sessionId: activeSession.sessionId,
        methods: { ...activeSession.stats },
        activeMethod: activeSession.activeMethod,
        audioFrames: activeSession.audioFrames,
        audioPackets: activeSession.audioPackets,
        audioPeakDb: activeSession.audioPeakDb,
        audioRmsDb: activeSession.audioRmsDb,
        videoFrames: activeSession.videoFrames,
        videoIntervalFrames: activeSession.videoIntervalFrames,
        videoLateFrames: activeSession.videoLateFrames,
        videoNoFrameCount: activeSession.videoNoFrameCount,
        videoRepeatedFrameCount: activeSession.videoRepeatedFrameCount,
        videoRecoverableLostCount: activeSession.videoRecoverableLostCount,
        videoAvgCaptureUs: activeSession.videoAvgCaptureUs,
        videoAvgReadbackUs: activeSession.videoAvgReadbackUs,
        videoAvgScaleUs: activeSession.videoAvgScaleUs,
        videoAvgPublishUs: activeSession.videoAvgPublishUs,
        videoSourceWidth: activeSession.videoSourceWidth,
        videoSourceHeight: activeSession.videoSourceHeight,
        videoContentWidth: activeSession.videoContentWidth,
        videoContentHeight: activeSession.videoContentHeight,
        captureThreadMmcss: activeSession.captureThreadMmcss,
      }
    : null
}
