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
}

let mediaEngineIpcRegistered = false
let mediaEngineHelper: ChildProcessWithoutNullStreams | null = null
let mediaEngineHelperReader: readline.Interface | null = null
let activeSession: ActiveMediaEngineSession | null = null
let pendingStartResolver: ((event: SidecarEvent) => void) | null = null
let mediaEngineStatus: NativeMediaSessionStatus = { status: 'idle' }
let lastMediaEngineError: string | null = null
let pendingNativePicker: PendingNativePicker | null = null
let getWindowRef: (() => BrowserWindow | null) | null = null
let startSessionQueue: Promise<unknown> = Promise.resolve()
let microphonePreviewHelper: ChildProcessWithoutNullStreams | null = null
let microphonePreviewSessionId: string | null = null

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
      cmd: 'start',
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
  lastError: string | null
  status?: NativeMediaSessionStatus
}

export function buildNativeMediaEngineSnapshot(
  input: NativeMediaEngineSnapshotInput,
): NativeMediaState {
  const supportsNativeMedia = input.platform === 'win32'
  const microphoneHelperAvailable = input.microphoneHelperAvailable ?? false
  const anyHelperAvailable = input.helperAvailable || microphoneHelperAvailable
  const activeSessions: NativeMediaEngineSessionSummary[] = input.activeSession
    ? [
        {
          kind:
            input.activeSession.audio?.mode === 'microphone'
              ? 'microphone'
              : 'screen',
          sessionId: input.activeSession.sessionId,
          status:
            input.status?.status === 'error'
              ? 'error'
              : input.status?.status === 'starting'
                ? 'starting'
                : 'running',
          port: input.activeSession.port,
          width: input.activeSession.width,
          height: input.activeSession.height,
          fps: input.activeSession.fps,
          bitrate: input.activeSession.bitrate,
          audio: input.activeSession.audio,
        },
      ]
    : []

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
    helperRunning: Boolean(mediaEngineHelper),
    activeSession,
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
    if (mediaEngineHelper) {
      writeHelperCommand(mediaEngineHelper, { cmd: 'stop' })
      mediaEngineHelper.kill()
      mediaEngineHelper = null
      mediaEngineHelperReader = null
    }

    const helper = ensureMediaEngineHelper('screen')
    const readyPromise = waitForSidecarReady()
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
  activeSession = null
  mediaEngineStatus = { status: 'idle' }
  lastMediaEngineError = message
  mediaEngineHelper = null
  mediaEngineHelperReader = null
}

function handleHelperExit(code: number | null, signal: NodeJS.Signals | null) {
  const session = activeSession
  if (!session) return

  const message =
    signal != null
      ? `Native media engine stopped (${signal})`
      : `Native media engine exited (${code ?? 'unknown'})`

  void handleSidecarFailure(session, 'exit', message)
}

function stopMediaEngineHelper(force = false) {
  if (mediaEngineHelper) {
    const stopped = writeHelperCommand(mediaEngineHelper, { cmd: 'stop' })
    if (force || !stopped) {
      mediaEngineHelper.kill()
      mediaEngineHelper = null
      mediaEngineHelperReader?.close()
      mediaEngineHelperReader = null
    }
  }

  pendingStartResolver = null
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

  if (activeSession?.sessionId === sessionId) {
    const written = writeHelperCommand(activeSession.helper, {
      cmd: 'configure',
      sessionId,
      ...config,
    })
    if (!written) {
      throw new Error('Native media helper is not writable')
    }
    return
  }

  throw new Error('Native microphone runtime is not active')
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

function ensureMediaEngineHelper(kind: NativeMediaSessionStartOptions['kind']) {
  if (mediaEngineHelper) return mediaEngineHelper

  const helperPath = resolveMediaEngineHelperPath(kind)
  if (!helperPath) {
    throw new Error('Native media engine is not available')
  }

  const helper = spawn(helperPath, [], {
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  })

  const reader = readline.createInterface({ input: helper.stdout })
  reader.on('line', (line) => {
    const event = parseSidecarEvent(line)
    if (!event) return

    if (event.type === 'session_lifecycle') {
      if (getWindowRef) {
        emitMediaEngineState(getWindowRef, mapLifecycleState(event))
      } else {
        mediaEngineStatus = mapLifecycleState(event)
        if (mediaEngineStatus.status === 'error') {
          lastMediaEngineError = mediaEngineStatus.message
        }
      }

      if (event.status === 'stopped') {
        activeSession = null
      }
      return
    }

    if (event.type === 'frame_method' && activeSession) {
      const method = mapFrameMethod(event.method)
      const activeMethod = mapFrameMethod(event.active_method ?? event.method)
      if (method) {
        activeSession.stats[method] = event.count
      }
      if (activeMethod) {
        activeSession.activeMethod = activeMethod
      }
      if (getWindowRef) {
        emitMediaEngineStats(getWindowRef, buildMediaEngineStatsEvent(activeSession))
      }
      return
    }

    if (event.type === 'microphone_metrics' && getWindowRef) {
      emitMicrophoneMetrics(getWindowRef, mapMicrophoneMetrics(event))
      return
    }

    if (event.type === 'track_published') {
      if (activeSession?.sessionId === event.session_id) {
        if (event.kind === 'video') activeSession.publishedVideo = true
        if (event.kind === 'audio') {
          activeSession.publishedAudio = true
          activeSession.audio = buildSessionAudio(
            activeSession.startOptions.kind === 'screen'
              ? activeSession.startOptions.audio?.requested
              : true,
            mapAudioMode(event.audio_mode),
            undefined,
            mapSidecarAudioMetadata(event),
          )
        }
        if (getWindowRef) {
          emitMediaEngineStats(getWindowRef, buildMediaEngineStatsEvent(activeSession))
        }
      }
      console.info(
        '[media-engine-helper] track published',
        event.session_id,
        event.kind,
        event.source,
      )
      return
    }

    if (event.type === 'screen_audio_frame') {
      if (activeSession?.sessionId === event.session_id) {
        activeSession.audioFrames = event.frames
        activeSession.audioPackets = event.packets
        activeSession.audioPeakDb = event.peak_db
        activeSession.audioRmsDb = event.rms_db
        activeSession.audio = buildSessionAudio(
          activeSession.startOptions.kind === 'screen'
            ? activeSession.startOptions.audio?.requested
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
          emitMediaEngineStats(getWindowRef, buildMediaEngineStatsEvent(activeSession))
        }
      }
      return
    }

    if (event.type === 'screen_video_frame') {
      if (activeSession?.sessionId === event.session_id) {
        const method = event.method ? mapFrameMethod(event.method) : null
        if (method) {
          activeSession.stats[method] = event.frames
          activeSession.activeMethod = method
        }
        activeSession.videoFrames = event.frames
        activeSession.videoIntervalFrames = event.interval_frames
        activeSession.videoLateFrames = event.late_frames
        activeSession.videoAvgCaptureUs = event.avg_capture_us
        if (getWindowRef) {
          emitMediaEngineStats(getWindowRef, buildMediaEngineStatsEvent(activeSession))
        }
      }
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
        sessionId: activeSession?.sessionId,
        message: event.message,
      }
      if (getWindowRef) {
        emitMediaEngineState(getWindowRef, errorState)
      } else {
        mediaEngineStatus = errorState
        lastMediaEngineError = event.message
      }
      pendingStartResolver?.(event)
      pendingStartResolver = null
      return
    }

    if (event.type === 'stopped') {
      activeSession = null
      return
    }

    pendingStartResolver?.(event)
    pendingStartResolver = null
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
    if (activeSession) {
      handleHelperExit(code, signal)
      return
    }
    mediaEngineHelper = null
    mediaEngineHelperReader = null
    mediaEngineStatus = { status: 'idle' }
  })

  mediaEngineHelper = helper
  mediaEngineHelperReader = reader
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

async function waitForSidecarReady(timeoutMs = 15_000) {
  return new Promise<SidecarEvent>((resolve, reject) => {
    const timer = setTimeout(() => {
      pendingStartResolver = null
      lastMediaEngineError = 'Native media engine timed out'
      reject(new Error('Native media engine timed out'))
    }, timeoutMs)

    pendingStartResolver = (event) => {
      clearTimeout(timer)
      if (event.type === 'error') {
        reject(new Error(event.message))
        return
      }
      resolve(event)
    }
  })
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
  stopMediaEngineHelper()

  const sessionId = crypto.randomUUID()

  if (options.kind === 'screen') {
    try {
      await runNativeScreenSharePreflight(options, getWindow)
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : 'Native screen share preflight failed'
      emitMediaEngineState(getWindow, {
        status: 'error',
        sessionId,
        message,
      })
      throw error
    }
  }

  const helper = ensureMediaEngineHelper(options.kind)
  const readyPromise = waitForSidecarReady()
  const startCommand = buildNativeMediaStartCommand(options, sessionId, getWindow)

  if (!writeHelperCommand(helper, startCommand)) {
    stopMediaEngineHelper(true)
    throw new Error('Native media helper is not writable')
  }

  let readyEvent: SidecarEvent
  try {
    readyEvent = await readyPromise
  } catch (error) {
    stopMediaEngineHelper(true)
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
    stopMediaEngineHelper(true)
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
  activeSession = {
    sessionId,
    port: options.kind === 'screen' ? readyEvent.port : undefined,
    width: readyEvent.width,
    height: readyEvent.height,
    fps: readyEvent.fps,
    bitrate: readyEvent.bitrate,
    audio,
    frameBufferPath: readyEvent.frame_buffer_path,
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

  if (options.kind === 'microphone') {
    if (!audio || audio.mode !== 'microphone') {
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

  const session: NativeMediaSession = {
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

  return session
}

export function registerNativeMediaEngineIpc(getWindow: () => BrowserWindow | null) {
  if (mediaEngineIpcRegistered) return
  mediaEngineIpcRegistered = true
  getWindowRef = getWindow

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
    if (sessionId && activeSession?.sessionId !== sessionId) return
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
