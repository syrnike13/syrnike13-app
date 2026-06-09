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
  type NativeMicrophonePreviewSession,
  type NativeMicrophonePreviewStartOptions,
  type NativeMicrophoneRuntimeConfig,
  type NativeMediaLiveKitCredentials,
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
  parseSidecarEvent,
  type SidecarEvent,
} from './native-media-engine-sidecar'

const NATIVE_PICKER_TIMEOUT_MS = 120_000
const MAX_SIDECAR_RECONNECT_ATTEMPTS = 1
const WARMED_MICROPHONE_SESSION_ID = 'native-microphone-monitor'
const NATIVE_MEDIA_STOP_TIMEOUT_MS = 5_000

export type PendingNativePicker = {
  id: string
  audioRequested: boolean
  sources: DesktopDisplayMediaSource[]
  timeout: ReturnType<typeof setTimeout>
}

type ActiveMediaEngineSession = {
  sessionId: string
  port?: number
  frameBufferPath?: string
  width?: number
  height?: number
  fps?: number
  bitrate?: number
  audio?: {
    port?: number
    mode: NativeMediaAudioMode
    sampleRate?: 48_000
    channels?: 1 | 2
    echoCancellation?: NativeMediaEchoCancellationMode
  }
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
  videoAvgCaptureUs?: number
  startOptions: NativeMediaSessionStartOptions
  reconnectAttempts: number
  reconnecting: boolean
  reader?: readline.Interface
}

type PendingStopResolver = {
  resolve: () => void
  reject: (error: Error) => void
  timeout: ReturnType<typeof setTimeout>
}

let mediaEngineIpcRegistered = false
let activeSession: ActiveMediaEngineSession | null = null
const activeSessions = new Map<string, ActiveMediaEngineSession>()
const pendingStartResolvers = new Map<string, (event: SidecarEvent) => void>()
const pendingStopResolvers = new Map<string, PendingStopResolver>()
let mediaEngineStatus: NativeMediaSessionStatus = { status: 'idle' }
let lastMediaEngineError: string | null = null
let pendingNativePicker: PendingNativePicker | null = null
let getWindowRef: (() => BrowserWindow | null) | null = null
let startSessionQueue: Promise<unknown> = Promise.resolve()
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
    echoCancellation?: NativeMediaEchoCancellationMode
    targetProcessId?: number
    loopbackMode?: import('@syrnike13/platform').NativeMediaLoopbackMode
  },
): NativeMediaSession['audio'] {
  if (!requested && mode === 'none' && !port) return undefined
  if (mode === 'microphone') {
    return {
      mode,
      port,
      sampleRate: metadata?.sampleRate ?? 48_000,
      channels: 1,
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

export function buildNativeMediaEngineSnapshot(
  input: NativeMediaEngineSnapshotInput,
): NativeMediaState {
  const supportsNativeMedia = input.platform === 'win32'
  const microphoneHelperAvailable = input.microphoneHelperAvailable ?? false
  const anyHelperAvailable = input.helperAvailable || microphoneHelperAvailable
  const statusSessionId =
    input.status && 'sessionId' in input.status
      ? input.status.sessionId
      : undefined
  const sessions = input.activeSessions
    ? Array.from(input.activeSessions)
    : input.activeSession
      ? [input.activeSession]
      : []
  const activeSessions: NativeMediaEngineSessionSummary[] = sessions.map(
    (session) => ({
      kind:
        session.startOptions?.kind === 'microphone' ||
        session.audio?.mode === 'microphone'
          ? 'microphone'
          : 'screen',
      sessionId: session.sessionId,
      status:
        statusSessionId === session.sessionId &&
        input.status?.status === 'error'
          ? 'error'
        : statusSessionId === session.sessionId &&
              input.status?.status === 'starting'
            ? 'starting'
            : 'running',
      port: session.port,
      width: session.width,
      height: session.height,
      fps: session.fps,
      bitrate: session.bitrate,
      audio: session.audio,
    }),
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
    videoAvgCaptureUs: session.videoAvgCaptureUs,
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

function nativeScreenLiveKitKey(livekit: NativeMediaLiveKitCredentials) {
  return `${livekit.url}\n${livekit.participantIdentity}`
}

function clearPreconnectedScreenSession(force = false) {
  const prepared = preconnectedScreenSession
  preconnectedScreenSession = null
  if (!prepared) return
  if (isHelperWritable(prepared.helper)) {
    writeHelperCommand(prepared.helper, {
      cmd: force ? 'stop' : 'disconnect_screen',
      sessionId: prepared.sessionId,
    })
  }
  if (force) {
    prepared.helper.kill()
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
    prewarmedMediaEngineHelper = null
    prewarmedMediaEngineReader?.close()
    prewarmedMediaEngineReader = null
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

function keepMicrophoneHelperWarmed(helper: ChildProcessWithoutNullStreams) {
  if (!isHelperWritable(helper)) {
    queueMicrophoneWarmupRestart()
    return
  }
  prewarmedMediaEngineHelper = helper
  attachPrewarmedMicrophoneReader(helper)
  attachPrewarmedMicrophoneExitHandler(helper)
}

export function prewarmNativeMediaEngineHelper(
  options: { allowDuringMicrophoneSession?: boolean } = {},
) {
  if (process.platform !== 'win32') return
  microphoneWarmupEnabled = true
  clearMicrophoneWarmupRestartTimer()
  if (isHelperWritable(prewarmedMediaEngineHelper)) return
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
  const helper = prewarmedMediaEngineHelper
  prewarmedMediaEngineHelper = null
  prewarmedMediaEngineReader?.close()
  prewarmedMediaEngineReader = null
  if (!helper) return
  writeHelperCommand(helper, { cmd: 'stop' })
  helper.kill()
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
  if (session.startOptions.kind !== 'screen') return false

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
    session.reader?.close()

    const helper = spawnMediaEngineHelper('screen', session.sessionId)
    const readyPromise = waitForSidecarReady(session.sessionId)
    writeHelperCommand(
      helper,
      buildScreenShareStartCommand(
        session.startOptions,
        session.sessionId,
        getWindow,
      ),
    )

    const readyEvent = await readyPromise
    if (readyEvent.type !== 'ready') {
      throw new Error('Native media engine reconnect failed')
    }

    session.port = readyEvent.port
    session.frameBufferPath = readyEvent.frame_buffer_path
    session.width = readyEvent.width
    session.height = readyEvent.height
    session.fps = readyEvent.fps
    session.bitrate = readyEvent.bitrate
    const audioMode = mapAudioMode(readyEvent.audio_mode)
    session.audio = buildSessionAudio(
      session.startOptions.audio?.requested,
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
    session.videoAvgCaptureUs = undefined
    session.helper = helper

    session.reconnecting = false
    return true
  } catch (error) {
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
  if (activeSession?.sessionId === session.sessionId) {
    activeSession =
      Array.from(activeSessions.values()).find(
        (active) => active.startOptions.kind === 'screen',
      ) ?? Array.from(activeSessions.values())[0] ?? null
  }
  mediaEngineStatus = { status: 'idle' }
  lastMediaEngineError = message
  rejectPendingStop(session.sessionId, new Error(message))
  if (session.startOptions.kind === 'microphone') {
    prewarmNativeMediaEngineHelper()
  }
}

function handleHelperExit(
  sessionId: string,
  code: number | null,
  signal: NodeJS.Signals | null,
) {
  const session = activeSessions.get(sessionId)
  if (!session) return

  const message =
    signal != null
      ? `Native media engine stopped (${signal})`
      : `Native media engine exited (${code ?? 'unknown'})`

  void handleSidecarFailure(session, 'exit', message)
}

function stopMediaEngineSession(sessionId: string, force = false) {
  const session = activeSessions.get(sessionId)
  if (!session) return false

  const isMicrophone = session.startOptions.kind === 'microphone'
  const isPreparedScreen =
    session.startOptions.kind === 'screen' &&
    preconnectedScreenSession?.helper === session.helper
  const stopped = writeHelperCommand(session.helper, {
    cmd:
      isMicrophone && !force
        ? 'disconnect_microphone'
        : isPreparedScreen && !force
          ? 'stop_screen_capture'
          : 'stop',
    sessionId,
  })
  if ((force || !stopped) && (!isPreparedScreen || force)) {
    session.helper.kill()
  } else if (!stopped && isPreparedScreen) {
    clearPreconnectedScreenSession(true)
  }
  session.reader?.close()
  activeSessions.delete(sessionId)
  if (isMicrophone && !force && stopped) {
    keepMicrophoneHelperWarmed(session.helper)
  }
  if (isPreparedScreen && force) {
    clearPreconnectedScreenSession(true)
  }

  if (activeSession?.sessionId === sessionId) {
    activeSession =
      Array.from(activeSessions.values()).find(
        (active) => active.startOptions.kind === 'screen',
      ) ?? Array.from(activeSessions.values())[0] ?? null
  }
  if (activeSessions.size === 0) {
    mediaEngineStatus = { status: 'idle' }
  }

  pendingStartResolvers.delete(sessionId)
  if (!stopped) {
    rejectPendingStop(sessionId, new Error('Native media helper is not writable'))
  }
  return stopped
}

function stopMediaEngineHelper(force = false) {
  for (const sessionId of Array.from(activeSessions.keys())) {
    stopMediaEngineSession(sessionId, force)
  }
  clearPreconnectedScreenSession(force)
  pendingStartResolvers.clear()
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

  if (existingHelper) return helper

  const reader = readline.createInterface({ input: helper.stdout })
  reader.on('line', (line) => {
    const event = parseSidecarEvent(line)
    if (!event) return
    const eventSessionId =
      'session_id' in event && typeof event.session_id === 'string'
        ? event.session_id
        : sessionId
    const session = activeSessions.get(eventSessionId)

    if (event.type === 'session_lifecycle') {
      console.info('[media-engine-helper] lifecycle', event)
      const debugEvent = event as typeof event & { elapsed_ms?: number }
      // #region debug log
      fetch('http://127.0.0.1:64953/ingest/ac639b', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sessionId: 'ac639b', runId: 'screen-share-startup', hypothesisId: 'D-sidecar', location: 'native-media-engine.ts:spawnMediaEngineHelper:session_lifecycle', message: 'screen sidecar lifecycle event', data: { nativeSessionId: event.session_id, kind: event.kind, status: event.status, sidecarMessage: event.message, elapsedMs: debugEvent.elapsed_ms, audioMode: event.audio_mode, width: event.width, height: event.height, fps: event.fps, bitrate: event.bitrate }, timestamp: Date.now() }) }).catch(() => {})
      // #endregion
      if (getWindowRef) {
        emitMediaEngineState(getWindowRef, mapLifecycleState(event))
      } else {
        mediaEngineStatus = mapLifecycleState(event)
        if (mediaEngineStatus.status === 'error') {
          lastMediaEngineError = mediaEngineStatus.message
        }
      }

      if (event.status === 'stopped') {
        resolvePendingStop(event.session_id)
        activeSessions.delete(event.session_id)
        if (activeSession?.sessionId === event.session_id) {
          activeSession =
            Array.from(activeSessions.values()).find(
              (active) => active.startOptions.kind === 'screen',
          ) ?? Array.from(activeSessions.values())[0] ?? null
        }
      }
      if (event.status === 'error') {
        rejectPendingStop(
          event.session_id,
          new Error(event.message ?? 'Native media engine failed'),
        )
        pendingStartResolvers.get(event.session_id)?.(event)
        pendingStartResolvers.delete(event.session_id)
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
      console.info('[media-engine-helper] microphone diagnostics', event)
      return
    }

    if (event.type === 'track_published') {
      const debugEvent = event as typeof event & {
        width?: number
        height?: number
        fps?: number
        bitrate?: number
      }
      // #region debug log
      fetch('http://127.0.0.1:64953/ingest/ac639b', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sessionId: 'ac639b', runId: 'screen-share-startup', hypothesisId: 'D-publish', location: 'native-media-engine.ts:spawnMediaEngineHelper:track_published', message: 'screen sidecar track published', data: { nativeSessionId: event.session_id, kind: event.kind, source: event.source, width: debugEvent.width, height: debugEvent.height, fps: debugEvent.fps, bitrate: debugEvent.bitrate, audioMode: event.audio_mode }, timestamp: Date.now() }) }).catch(() => {})
      // #endregion
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
      return
    }

    if (event.type === 'screen_video_frame') {
      // #region debug log
      fetch('http://127.0.0.1:64953/ingest/ac639b', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sessionId: 'ac639b', runId: 'screen-share-startup', hypothesisId: 'E-first-frame', location: 'native-media-engine.ts:spawnMediaEngineHelper:screen_video_frame', message: 'screen sidecar video frame stats', data: { nativeSessionId: event.session_id, frames: event.frames, intervalFrames: event.interval_frames, lateFrames: event.late_frames, avgCaptureUs: event.avg_capture_us, method: event.method }, timestamp: Date.now() }) }).catch(() => {})
      // #endregion
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
        videoSession.videoAvgCaptureUs = event.avg_capture_us
        if (getWindowRef) {
          emitMediaEngineStats(getWindowRef, buildMediaEngineStatsEvent(videoSession))
        }
      }
      console.info('[media-engine-helper] screen video diagnostics', event)
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
      if (activeSession?.sessionId === sessionId) {
        activeSession =
          Array.from(activeSessions.values()).find(
            (active) => active.startOptions.kind === 'screen',
          ) ?? Array.from(activeSessions.values())[0] ?? null
      }
      return
    }

    pendingStartResolvers.get(eventSessionId)?.(event)
    pendingStartResolvers.delete(eventSessionId)
  })

  helper.stderr.on('data', (chunk) => {
    const text = chunk.toString()
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
        handleHelperExit(session.sessionId, code, signal)
      }
    } else if (activeSessions.has(sessionId)) {
      handleHelperExit(sessionId, code, signal)
    }
    if (preconnectedScreenSession?.helper === helper) {
      preconnectedScreenSession = null
    }
    mediaEngineStatus = { status: 'idle' }
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
    const timer = setTimeout(() => {
      pendingStartResolvers.delete(sessionId)
      lastMediaEngineError = 'Native media engine timed out'
      reject(new Error('Native media engine timed out'))
    }, timeoutMs)

    pendingStartResolvers.set(sessionId, (event) => {
      clearTimeout(timer)
      if (event.type === 'error') {
        reject(new Error(event.message))
        return
      }
      if (event.type === 'session_lifecycle' && event.status === 'error') {
        reject(new Error(event.message ?? 'Native media engine failed to start'))
        return
      }
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
  return new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      pendingStopResolvers.delete(sessionId)
      reject(new Error('Native media engine stop timed out'))
    }, NATIVE_MEDIA_STOP_TIMEOUT_MS)

    pendingStopResolvers.set(sessionId, {
      resolve,
      reject,
      timeout,
    })
  })
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

async function getPreconnectedScreenHelper(
  livekit: NativeMediaLiveKitCredentials,
) {
  const current = preconnectedScreenSession
  if (!current) return null
  if (current.livekitKey !== nativeScreenLiveKitKey(livekit)) return null
  if (!isHelperWritable(current.helper)) {
    preconnectedScreenSession = null
    return null
  }
  await current.ready
  return current.helper
}

function mapSidecarAudioMetadata(event: {
  audio_sample_rate?: number
  audio_channels?: number
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
    echoCancellation: mapEchoCancellationMode(event.echo_cancellation),
    targetProcessId:
      typeof event.audio_target_process_id === 'number'
        ? event.audio_target_process_id
        : undefined,
    loopbackMode: mapLoopbackMode(event.audio_loopback_mode),
  } satisfies {
    sampleRate?: 48_000
    channels?: 1 | 2
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

  const sessionId = crypto.randomUUID()
  const debugStartedAt = Date.now()
  // #region debug log
  if (options.kind === 'screen') {
    fetch('http://127.0.0.1:64953/ingest/ac639b', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sessionId: 'ac639b', runId: 'screen-share-startup', hypothesisId: 'B-main', location: 'native-media-engine.ts:startNativeMediaSession', message: 'screen native session entered main process', data: { nativeSessionId: sessionId, width: options.width, height: options.height, fps: options.fps, bitrate: options.bitrate, audioRequested: Boolean(options.audio?.requested), sourceKind: options.sourceId.split(':')[0] }, timestamp: Date.now() }) }).catch(() => {})
  }
  // #endregion

  const preparedScreenHelper =
    options.kind === 'screen'
      ? await getPreconnectedScreenHelper(options.livekit)
      : null
  const helper = spawnMediaEngineHelper(
    options.kind,
    sessionId,
    preparedScreenHelper ?? undefined,
  )
  const session: ActiveMediaEngineSession = {
    sessionId,
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
    videoAvgCaptureUs: undefined,
    startOptions: options,
    reconnectAttempts: 0,
    reconnecting: false,
  }
  activeSessions.set(sessionId, session)
  activeSession = options.kind === 'screen' || !activeSession ? session : activeSession

  const readyPromise = waitForSidecarReady(sessionId)
  const startCommand = buildNativeMediaStartCommand(options, sessionId, getWindow)

  if (!writeHelperCommand(helper, startCommand)) {
    stopMediaEngineSession(sessionId, true)
    throw new Error('Native media helper is not writable')
  }
  // #region debug log
  if (options.kind === 'screen') {
    fetch('http://127.0.0.1:64953/ingest/ac639b', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sessionId: 'ac639b', runId: 'screen-share-startup', hypothesisId: 'C-spawn-write', location: 'native-media-engine.ts:startNativeMediaSession', message: 'screen helper start command written', data: { nativeSessionId: sessionId, elapsedMs: Date.now() - debugStartedAt }, timestamp: Date.now() }) }).catch(() => {})
  }
  // #endregion

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
  // #region debug log
  if (options.kind === 'screen') {
    fetch('http://127.0.0.1:64953/ingest/ac639b', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sessionId: 'ac639b', runId: 'screen-share-startup', hypothesisId: 'D-ready', location: 'native-media-engine.ts:startNativeMediaSession', message: 'screen helper ready resolved', data: { nativeSessionId: sessionId, readyType: readyEvent.type, elapsedMs: Date.now() - debugStartedAt }, timestamp: Date.now() }) }).catch(() => {})
  }
  // #endregion
  if (readyEvent.type !== 'ready') {
    stopMediaEngineSession(sessionId, true)
    throw new Error('Native media engine failed to start')
  }

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
        echoCancellation: audioMetadata.echoCancellation ?? 'disabled',
      },
      nativeParticipantIdentity:
        readyEvent.native_participant_identity ??
        options.livekit.participantIdentity,
    }
  }

  const encoder = mapEncoderBackend(readyEvent.encoder)

  const screenSession: NativeMediaSession = {
    kind: 'screen',
    sessionId,
    port: readyEvent.port || undefined,
    encoder,
    width: readyEvent.width,
    height: readyEvent.height,
    fps: readyEvent.fps,
    bitrate: readyEvent.bitrate,
    audio,
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
      const prepare = startSessionQueue.then(() =>
        prepareNativeScreenSession(getWindow, options),
      )
      startSessionQueue = prepare.catch(() => undefined)
      return prepare
    },
  )

  ipcMain.handle(IPC.mediaDisconnectPreparedScreenSession, async (event) => {
    if (!isTrustedSender(event, getWindow)) return
    clearPreconnectedScreenSession(false)
  })

  ipcMain.handle(
    IPC.mediaStartSession,
    async (event, options: NativeMediaSessionStartOptions) => {
      if (!isTrustedSender(event, getWindow)) {
        throw new Error('Untrusted media engine start request')
      }
      const start = startSessionQueue.then(() =>
        startNativeMediaSession(getWindow, options),
      )
      startSessionQueue = start.catch(() => undefined)
      return start
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
        videoAvgCaptureUs: activeSession.videoAvgCaptureUs,
      }
    : null
}
