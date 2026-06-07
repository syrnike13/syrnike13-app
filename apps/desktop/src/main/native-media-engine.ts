import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import fs from 'node:fs'
import net from 'node:net'
import path from 'node:path'
import readline from 'node:readline'

import { app, ipcMain, type BrowserWindow, type IpcMainInvokeEvent } from 'electron'
import {
  IPC,
  type DesktopDisplayMediaRequest,
  type DesktopOs,
  type NativeMediaAudioMode,
  type NativeMediaEngineSessionSummary,
  type NativeMediaFrameMethod,
  type NativeMediaFrameStats,
  type NativeMediaSession,
  type NativeMediaSidecarLostEvent,
  type NativeMediaSessionStartOptions,
  type NativeMediaSessionStatus,
  type NativeMediaState,
  type NativeMediaStateEvent,
  type NativeMediaStatsEvent,
  type NativeMediaStreamMode,
} from '@syrnike13/platform'

import {
  isSharedFrameSignal,
  mapAudioMode,
  mapEncoderBackend,
  mapFrameMethod,
  mapLifecycleState,
  mapStreamMode,
  parseSidecarEvent,
  readBgraFramePacketAsync,
  type SidecarEvent,
} from './native-media-engine-sidecar'

const NATIVE_PICKER_TIMEOUT_MS = 120_000
const MAX_SIDECAR_RECONNECT_ATTEMPTS = 1

export type PendingNativePicker = {
  id: string
  audioRequested: boolean
  sources: Electron.DesktopCapturerSource[]
  timeout: ReturnType<typeof setTimeout>
}

type ActiveMediaEngineSession = {
  sessionId: string
  port: number
  streamMode: NativeMediaStreamMode
  frameBufferPath?: string
  audio?: {
    port?: number
    mode: NativeMediaAudioMode
  }
  helper: ChildProcessWithoutNullStreams
  stats: NativeMediaFrameStats
  activeMethod?: NativeMediaFrameMethod
  socket: net.Socket | null
  socketReadBuffer: Buffer
  audioSocket: net.Socket | null
  audioSocketReadBuffer: Buffer
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
): NativeMediaSession['audio'] {
  if (!requested && mode === 'none' && !port) return undefined
  return { mode, port }
}

function readWindowHwnd(win: BrowserWindow): number | undefined {
  const handle = win.getNativeWindowHandle()
  if (handle.length < 4) return undefined
  return handle.readInt32LE(0)
}

function buildScreenShareStartCommand(
  options: NativeMediaSessionStartOptions,
  sessionId: string,
  getWindow: () => BrowserWindow | null,
) {
  const win = getWindow()
  return {
    cmd: 'start',
    sessionId,
    sessionKind: options.kind,
    target: { id: options.sourceId },
    width: options.width,
    height: options.height,
    fps: options.fps,
    bitrate: options.bitrate,
    streamMode: options.streamMode ?? 'bgra',
    audio: Boolean(options.audio?.requested),
    excludeProcessId: process.pid,
    selfWindowHwnd:
      win && !win.isDestroyed() ? readWindowHwnd(win) : undefined,
  }
}

function assertScreenSessionOptions(
  options: NativeMediaSessionStartOptions,
): asserts options is Extract<NativeMediaSessionStartOptions, { kind: 'screen' }> {
  if (options.kind !== 'screen') {
    throw new Error(`Unsupported native media session kind: ${String(options.kind)}`)
  }
}

function resolveMediaEngineHelperPath() {
  const helperName = 'syrnike-capture-helper-win.exe'
  const candidates = app.isPackaged
    ? [path.join(process.resourcesPath, 'native', helperName)]
    : [
        path.resolve(app.getAppPath(), 'out/native', helperName),
        path.resolve(
          app.getAppPath(),
          'native/capture-helper-win/target/release',
          helperName,
        ),
        path.resolve(
          app.getAppPath(),
          'native/capture-helper-win/target/debug',
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
  helperRunning: boolean
  activeSession: ActiveMediaEngineSession | null
  lastError: string | null
  status?: NativeMediaSessionStatus
}

export function buildNativeMediaEngineSnapshot(
  input: NativeMediaEngineSnapshotInput,
): NativeMediaState {
  const supportsNativeMedia = input.platform === 'win32'
  const activeSessions: NativeMediaEngineSessionSummary[] = input.activeSession
    ? [
        {
          kind: 'screen',
          sessionId: input.activeSession.sessionId,
          status:
            input.status?.status === 'error'
              ? 'error'
              : input.status?.status === 'starting'
                ? 'starting'
                : 'running',
          port: input.activeSession.port,
        },
      ]
    : []

  return {
    ...(input.status ?? { status: 'idle' }),
    engine: {
      available: supportsNativeMedia && input.helperAvailable,
      helper: {
        available: input.helperAvailable,
        running: input.helperRunning,
      },
      capabilities: {
        screen: supportsNativeMedia && input.helperAvailable,
        systemAudio: supportsNativeMedia && input.helperAvailable,
        microphone: false,
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

function emitSidecarLost(
  getWindow: () => BrowserWindow | null,
  event: NativeMediaSidecarLostEvent,
) {
  const win = getWindow()
  if (!win || win.isDestroyed()) return
  win.webContents.send(IPC.mediaEngineLost, event)
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

function cleanupFrameBuffer(session: ActiveMediaEngineSession | null) {
  if (!session?.frameBufferPath) return
  try {
    fs.unlinkSync(session.frameBufferPath)
  } catch {
    // ignore
  }
}

function stopStreamRelay(session: ActiveMediaEngineSession | null) {
  if (!session) return
  if (session.socket) {
    session.socket.removeAllListeners()
    session.socket.destroy()
    session.socket = null
  }
  session.socketReadBuffer = Buffer.alloc(0)
  if (session.audioSocket) {
    session.audioSocket.removeAllListeners()
    session.audioSocket.destroy()
    session.audioSocket = null
  }
  session.audioSocketReadBuffer = Buffer.alloc(0)
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

function forwardStreamPayload(
  getWindow: () => BrowserWindow | null,
  session: ActiveMediaEngineSession,
  payload: Buffer,
) {
  const win = getWindow()
  if (!win || win.isDestroyed()) return

  const framed = Buffer.alloc(4 + payload.length)
  framed.writeUInt32LE(payload.length, 0)
  payload.copy(framed, 4)

  const arrayBuffer = framed.buffer.slice(
    framed.byteOffset,
    framed.byteOffset + framed.byteLength,
  )
  win.webContents.send(IPC.mediaStreamChunk, {
    sessionId: session.sessionId,
    chunk: arrayBuffer,
  })
}

function processLengthPrefixedBuffer(
  readBuffer: Buffer,
  onPayload: (payload: Buffer) => void,
): Buffer {
  let buffer = readBuffer
  while (buffer.length >= 4) {
    const length = buffer.readUInt32LE(0)
    if (buffer.length < 4 + length) break

    const payload = buffer.subarray(4, 4 + length)
    buffer = buffer.subarray(4 + length)
    onPayload(payload)
  }
  return buffer
}

function processStreamBuffer(
  getWindow: () => BrowserWindow | null,
  session: ActiveMediaEngineSession,
) {
  session.socketReadBuffer = processLengthPrefixedBuffer(
    session.socketReadBuffer,
    (payload) => forwardStreamPayload(getWindow, session, payload),
  )
}

function forwardStreamAudioPayload(
  getWindow: () => BrowserWindow | null,
  session: ActiveMediaEngineSession,
  payload: Buffer,
) {
  const win = getWindow()
  if (!win || win.isDestroyed()) return

  const arrayBuffer = payload.buffer.slice(
    payload.byteOffset,
    payload.byteOffset + payload.byteLength,
  )
  win.webContents.send(IPC.mediaStreamAudioChunk, {
    sessionId: session.sessionId,
    chunk: arrayBuffer,
  })
}

function processAudioStreamBuffer(
  getWindow: () => BrowserWindow | null,
  session: ActiveMediaEngineSession,
) {
  session.audioSocketReadBuffer = processLengthPrefixedBuffer(
    session.audioSocketReadBuffer,
    (payload) => forwardStreamAudioPayload(getWindow, session, payload),
  )
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
    stopStreamRelay(session)
    cleanupFrameBuffer(session)

    if (mediaEngineHelper) {
      try {
        mediaEngineHelper.stdin.write(`${JSON.stringify({ cmd: 'stop' })}\n`)
      } catch {
        // ignore
      }
      mediaEngineHelper.kill()
      mediaEngineHelper = null
      mediaEngineHelperReader = null
    }

    const helper = ensureMediaEngineHelper()
    const readyPromise = waitForSidecarReady()
    helper.stdin.write(
      `${JSON.stringify(
        buildScreenShareStartCommand(
          session.startOptions,
          session.sessionId,
          getWindow,
        ),
      )}\n`,
    )

    const readyEvent = await readyPromise
    if (readyEvent.type !== 'ready') {
      throw new Error('Native media engine reconnect failed')
    }

    session.port = readyEvent.port
    session.streamMode = mapStreamMode(readyEvent.stream_mode)
    session.frameBufferPath = readyEvent.frame_buffer_path
    const audioMode = mapAudioMode(readyEvent.audio_mode)
    session.audio = buildSessionAudio(
      session.startOptions.audio?.requested,
      audioMode,
      readyEvent.audio_port,
    )
    session.stats = emptyStats()
    session.activeMethod = undefined
    session.socketReadBuffer = Buffer.alloc(0)
    session.audioSocketReadBuffer = Buffer.alloc(0)
    attachStreamRelay(getWindow, session)

    emitMediaEngineState(getWindow, {
      status: 'running',
      sessionId: session.sessionId,
      port: readyEvent.port,
    })

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
  stopStreamRelay(session)
  cleanupFrameBuffer(session)
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

function attachStreamRelay(
  getWindow: () => BrowserWindow | null,
  session: ActiveMediaEngineSession,
) {
  const socket = net.connect(session.port, '127.0.0.1')
  session.socket = socket

  socket.on('data', (chunk) => {
    session.socketReadBuffer = Buffer.concat([session.socketReadBuffer, chunk])
    processStreamBuffer(getWindow, session)
  })

  socket.on('end', () => {
    const win = getWindow()
    if (!win || win.isDestroyed()) return
    win.webContents.send(IPC.mediaStreamEnded, session.sessionId)
  })

  socket.on('error', (error) => {
    if (activeSession?.sessionId === session.sessionId) {
      void handleSidecarFailure(session, 'stream_error', error.message)
    }
  })

  if (session.audio?.port) {
    attachAudioStreamRelay(getWindow, session)
  }
}

function attachAudioStreamRelay(
  getWindow: () => BrowserWindow | null,
  session: ActiveMediaEngineSession,
) {
  if (!session.audio?.port) return

  const socket = net.connect(session.audio.port, '127.0.0.1')
  session.audioSocket = socket

  socket.on('data', (chunk) => {
    session.audioSocketReadBuffer = Buffer.concat([
      session.audioSocketReadBuffer,
      chunk,
    ])
    processAudioStreamBuffer(getWindow, session)
  })

  socket.on('error', (error) => {
    console.warn('[media-engine] audio stream error', error.message)
  })
}

function stopMediaEngineHelper() {
  cleanupFrameBuffer(activeSession)
  stopStreamRelay(activeSession)

  if (mediaEngineHelper) {
    try {
      mediaEngineHelper.stdin.write(`${JSON.stringify({ cmd: 'stop' })}\n`)
    } catch {
      mediaEngineHelper.kill()
      mediaEngineHelper = null
      mediaEngineHelperReader?.close()
      mediaEngineHelperReader = null
    }
  }

  pendingStartResolver = null
}

function ensureMediaEngineHelper() {
  if (mediaEngineHelper) return mediaEngineHelper

  const helperPath = resolveMediaEngineHelperPath()
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
        cleanupFrameBuffer(activeSession)
        stopStreamRelay(activeSession)
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
        emitMediaEngineStats(getWindowRef, {
          sessionId: activeSession.sessionId,
          methods: { ...activeSession.stats },
          activeMethod: activeSession.activeMethod,
        })
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
      mediaEngineStatus = { status: 'error', message: event.message }
      lastMediaEngineError = event.message
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
    console.error('[media-engine-helper]', chunk.toString())
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

async function startNativeScreenShareSession(
  getWindow: () => BrowserWindow | null,
  options: NativeMediaSessionStartOptions,
): Promise<NativeMediaSession> {
  assertScreenSessionOptions(options)

  if (process.platform !== 'win32') {
    throw new Error('Native media engine is only available on Windows')
  }

  getWindowRef = getWindow
  stopMediaEngineHelper()

  const sessionId = crypto.randomUUID()

  const helper = ensureMediaEngineHelper()
  const readyPromise = waitForSidecarReady()

  helper.stdin.write(
    `${JSON.stringify(buildScreenShareStartCommand(options, sessionId, getWindow))}\n`,
  )

  const readyEvent = await readyPromise
  if (readyEvent.type !== 'ready') {
    throw new Error('Native media engine failed to start')
  }

  const streamMode = mapStreamMode(readyEvent.stream_mode)
  const encoder = mapEncoderBackend(readyEvent.encoder)
  const audioMode = mapAudioMode(readyEvent.audio_mode)

  activeSession = {
    sessionId,
    port: readyEvent.port,
    audio: buildSessionAudio(
      options.audio?.requested,
      audioMode,
      readyEvent.audio_port,
    ),
    streamMode,
    frameBufferPath: readyEvent.frame_buffer_path,
    helper,
    stats: emptyStats(),
    socket: null,
    socketReadBuffer: Buffer.alloc(0),
    audioSocket: null,
    audioSocketReadBuffer: Buffer.alloc(0),
    startOptions: options,
    reconnectAttempts: 0,
    reconnecting: false,
  }
  attachStreamRelay(getWindow, activeSession)

  const session: NativeMediaSession = {
    kind: 'screen',
    sessionId,
    port: readyEvent.port,
    streamMode,
    encoder,
    audio: buildSessionAudio(
      options.audio?.requested,
      audioMode,
      readyEvent.audio_port,
    ),
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
      return startNativeScreenShareSession(getWindow, options)
    },
  )

  ipcMain.handle(IPC.mediaStopSession, async (event, sessionId?: string) => {
    if (!isTrustedSender(event, getWindow)) return
    if (sessionId && activeSession?.sessionId !== sessionId) return
    stopMediaEngineHelper()
  })

  ipcMain.handle(
    IPC.mediaReadSharedFrame,
    async (event, sessionId: string) => {
      if (!isTrustedSender(event, getWindow)) return null
      if (
        !activeSession ||
        activeSession.sessionId !== sessionId ||
        !activeSession.frameBufferPath
      ) {
        return null
      }

      try {
        const framePayload = await readBgraFramePacketAsync(
          activeSession.frameBufferPath,
        )
        return framePayload.buffer.slice(
          framePayload.byteOffset,
          framePayload.byteOffset + framePayload.byteLength,
        )
      } catch {
        return null
      }
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
      }
    : null
}
