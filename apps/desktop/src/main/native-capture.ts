import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import fs from 'node:fs'
import net from 'node:net'
import path from 'node:path'
import readline from 'node:readline'

import { app, ipcMain, type BrowserWindow, type IpcMainInvokeEvent } from 'electron'
import {
  IPC,
  type DesktopDisplayMediaRequest,
  type NativeCaptureAudioMode,
  type NativeCaptureFrameMethod,
  type NativeCaptureFrameStats,
  type NativeCaptureSession,
  type NativeCaptureSidecarLostEvent,
  type NativeCaptureStartOptions,
  type NativeCaptureState,
  type NativeCaptureStateEvent,
  type NativeCaptureStatsEvent,
  type NativeCaptureStreamMode,
} from '@syrnike13/platform'

import {
  isSharedFrameSignal,
  mapAudioMode,
  mapEncoderBackend,
  mapFrameMethod,
  mapStreamMode,
  parseSidecarEvent,
  readBgraFramePacketAsync,
  type SidecarEvent,
} from './native-capture-sidecar'
import {
  clearNativeAudioLoopbackSource,
  rememberNativeAudioLoopbackSource,
} from './media-permissions'

const NATIVE_PICKER_TIMEOUT_MS = 120_000
const MAX_SIDECAR_RECONNECT_ATTEMPTS = 1

export type PendingNativePicker = {
  id: string
  audioRequested: boolean
  sources: Electron.DesktopCapturerSource[]
  timeout: ReturnType<typeof setTimeout>
}

type ActiveCaptureSession = {
  sessionId: string
  port: number
  streamMode: NativeCaptureStreamMode
  frameBufferPath?: string
  audioPort?: number
  audioMode?: NativeCaptureAudioMode
  helper: ChildProcessWithoutNullStreams
  stats: NativeCaptureFrameStats
  activeMethod?: NativeCaptureFrameMethod
  socket: net.Socket | null
  socketReadBuffer: Buffer
  audioSocket: net.Socket | null
  audioSocketReadBuffer: Buffer
  startOptions: NativeCaptureStartOptions
  reconnectAttempts: number
  reconnecting: boolean
}

let captureIpcRegistered = false
let captureHelper: ChildProcessWithoutNullStreams | null = null
let captureHelperReader: readline.Interface | null = null
let activeSession: ActiveCaptureSession | null = null
let pendingStartResolver: ((event: SidecarEvent) => void) | null = null
let captureState: NativeCaptureState = { status: 'idle' }
let pendingNativePicker: PendingNativePicker | null = null
let getWindowRef: (() => BrowserWindow | null) | null = null

function isTrustedSender(
  event: IpcMainInvokeEvent,
  getWindow: () => BrowserWindow | null,
) {
  const win = getWindow()
  return Boolean(win && !win.isDestroyed() && event.sender === win.webContents)
}

function emptyStats(): NativeCaptureFrameStats {
  return {
    wgc: 0,
    dxgi: 0,
    gdi_blt: 0,
    gdi_print: 0,
  }
}

function readWindowHwnd(win: BrowserWindow): number | undefined {
  const handle = win.getNativeWindowHandle()
  if (handle.length < 4) return undefined
  return handle.readInt32LE(0)
}

function buildCaptureStartCommand(
  options: NativeCaptureStartOptions,
  getWindow: () => BrowserWindow | null,
) {
  const win = getWindow()
  return {
    cmd: 'start',
    target: { id: options.sourceId },
    width: options.width,
    height: options.height,
    fps: options.fps,
    bitrate: options.bitrate,
    streamMode: options.streamMode ?? 'bgra',
    audio: Boolean(options.withAudio),
    excludeProcessId: process.pid,
    selfWindowHwnd:
      win && !win.isDestroyed() ? readWindowHwnd(win) : undefined,
  }
}

function resolveCaptureHelperPath() {
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

function emitCaptureState(
  getWindow: () => BrowserWindow | null,
  next: NativeCaptureStateEvent,
) {
  captureState = next
  const win = getWindow()
  if (!win || win.isDestroyed()) return
  win.webContents.send(IPC.captureStateChanged, next)
}

function emitCaptureStats(
  getWindow: () => BrowserWindow | null,
  event: NativeCaptureStatsEvent,
) {
  const win = getWindow()
  if (!win || win.isDestroyed()) return
  win.webContents.send(IPC.captureStats, event)
}

function emitSidecarLost(
  getWindow: () => BrowserWindow | null,
  event: NativeCaptureSidecarLostEvent,
) {
  const win = getWindow()
  if (!win || win.isDestroyed()) return
  win.webContents.send(IPC.captureSidecarLost, event)
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

function cleanupFrameBuffer(session: ActiveCaptureSession | null) {
  if (!session?.frameBufferPath) return
  try {
    fs.unlinkSync(session.frameBufferPath)
  } catch {
    // ignore
  }
}

function stopStreamRelay(session: ActiveCaptureSession | null) {
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
  session: ActiveCaptureSession,
  reason: NativeCaptureSidecarLostEvent['reason'],
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
    win.webContents.send(IPC.captureStreamError, {
      sessionId: session.sessionId,
      message,
    })
    win.webContents.send(IPC.captureStreamEnded, session.sessionId)
  }
}

function forwardStreamPayload(
  getWindow: () => BrowserWindow | null,
  session: ActiveCaptureSession,
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
  win.webContents.send(IPC.captureStreamChunk, {
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
  session: ActiveCaptureSession,
) {
  session.socketReadBuffer = processLengthPrefixedBuffer(
    session.socketReadBuffer,
    (payload) => forwardStreamPayload(getWindow, session, payload),
  )
}

function forwardStreamAudioPayload(
  getWindow: () => BrowserWindow | null,
  session: ActiveCaptureSession,
  payload: Buffer,
) {
  const win = getWindow()
  if (!win || win.isDestroyed()) return

  const arrayBuffer = payload.buffer.slice(
    payload.byteOffset,
    payload.byteOffset + payload.byteLength,
  )
  win.webContents.send(IPC.captureStreamAudioChunk, {
    sessionId: session.sessionId,
    chunk: arrayBuffer,
  })
}

function processAudioStreamBuffer(
  getWindow: () => BrowserWindow | null,
  session: ActiveCaptureSession,
) {
  session.audioSocketReadBuffer = processLengthPrefixedBuffer(
    session.audioSocketReadBuffer,
    (payload) => forwardStreamAudioPayload(getWindow, session, payload),
  )
}

async function attemptSidecarReconnect(session: ActiveCaptureSession) {
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

    if (captureHelper) {
      try {
        captureHelper.stdin.write(`${JSON.stringify({ cmd: 'stop' })}\n`)
      } catch {
        // ignore
      }
      captureHelper.kill()
      captureHelper = null
      captureHelperReader = null
    }

    const helper = ensureCaptureHelper()
    const readyPromise = waitForSidecarReady()
    helper.stdin.write(
      `${JSON.stringify(buildCaptureStartCommand(session.startOptions, getWindow))}\n`,
    )

    const readyEvent = await readyPromise
    if (readyEvent.type !== 'ready') {
      throw new Error('Native capture reconnect failed')
    }

    session.port = readyEvent.port
    session.streamMode = mapStreamMode(readyEvent.stream_mode)
    session.frameBufferPath = readyEvent.frame_buffer_path
    session.audioPort = readyEvent.audio_port
    session.audioMode = mapAudioMode(readyEvent.audio_mode)
    session.stats = emptyStats()
    session.activeMethod = undefined
    session.socketReadBuffer = Buffer.alloc(0)
    session.audioSocketReadBuffer = Buffer.alloc(0)
    attachStreamRelay(getWindow, session)

    emitCaptureState(getWindow, {
      status: 'running',
      sessionId: session.sessionId,
      port: readyEvent.port,
    })

    session.reconnecting = false
    return true
  } catch (error) {
    session.reconnecting = false
    console.warn('[capture] sidecar reconnect failed', error)
    return false
  }
}

async function handleSidecarFailure(
  session: ActiveCaptureSession,
  reason: NativeCaptureSidecarLostEvent['reason'],
  message: string,
) {
  const reconnected = await attemptSidecarReconnect(session)
  if (reconnected) return

  notifySidecarLost(session, reason, message)
  stopStreamRelay(session)
  cleanupFrameBuffer(session)
  activeSession = null
  captureState = { status: 'idle' }
  captureHelper = null
  captureHelperReader = null
}

function handleHelperExit(code: number | null, signal: NodeJS.Signals | null) {
  const session = activeSession
  if (!session) return

  const message =
    signal != null
      ? `Native capture helper stopped (${signal})`
      : `Native capture helper exited (${code ?? 'unknown'})`

  void handleSidecarFailure(session, 'exit', message)
}

function attachStreamRelay(
  getWindow: () => BrowserWindow | null,
  session: ActiveCaptureSession,
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
    win.webContents.send(IPC.captureStreamEnded, session.sessionId)
  })

  socket.on('error', (error) => {
    if (activeSession?.sessionId === session.sessionId) {
      void handleSidecarFailure(session, 'stream_error', error.message)
    }
  })

  if (session.audioPort) {
    attachAudioStreamRelay(getWindow, session)
  }
}

function attachAudioStreamRelay(
  getWindow: () => BrowserWindow | null,
  session: ActiveCaptureSession,
) {
  if (!session.audioPort) return

  const socket = net.connect(session.audioPort, '127.0.0.1')
  session.audioSocket = socket

  socket.on('data', (chunk) => {
    session.audioSocketReadBuffer = Buffer.concat([
      session.audioSocketReadBuffer,
      chunk,
    ])
    processAudioStreamBuffer(getWindow, session)
  })

  socket.on('error', (error) => {
    console.warn('[capture] audio stream error', error.message)
  })
}

function stopCaptureHelper() {
  cleanupFrameBuffer(activeSession)
  stopStreamRelay(activeSession)
  captureHelperReader?.close()
  captureHelperReader = null

  if (captureHelper) {
    try {
      captureHelper.stdin.write(`${JSON.stringify({ cmd: 'stop' })}\n`)
    } catch {
      // ignore
    }
    captureHelper.kill()
    captureHelper = null
  }

  activeSession = null
  pendingStartResolver = null
}

function ensureCaptureHelper() {
  if (captureHelper) return captureHelper

  const helperPath = resolveCaptureHelperPath()
  if (!helperPath) {
    throw new Error('Native capture helper is not available')
  }

  const helper = spawn(helperPath, [], {
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  })

  const reader = readline.createInterface({ input: helper.stdout })
  reader.on('line', (line) => {
    const event = parseSidecarEvent(line)
    if (!event) return

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
        emitCaptureStats(getWindowRef, {
          sessionId: activeSession.sessionId,
          methods: { ...activeSession.stats },
          activeMethod: activeSession.activeMethod,
        })
      }
      return
    }

    if (event.type === 'downgrade') {
      console.warn(
        '[capture-helper] downgrade',
        event.from,
        '->',
        event.to,
        event.reason,
      )
      return
    }

    if (event.type === 'error') {
      captureState = { status: 'error', message: event.message }
      pendingStartResolver?.(event)
      pendingStartResolver = null
      return
    }

    if (event.type === 'stopped') {
      activeSession = null
      captureState = { status: 'idle' }
      return
    }

    pendingStartResolver?.(event)
    pendingStartResolver = null
  })

  helper.stderr.on('data', (chunk) => {
    console.error('[capture-helper]', chunk.toString())
  })

  helper.on('exit', (code, signal) => {
    if (activeSession) {
      handleHelperExit(code, signal)
      return
    }
    captureHelper = null
    captureHelperReader = null
    captureState = { status: 'idle' }
  })

  captureHelper = helper
  captureHelperReader = reader
  return helper
}

async function waitForSidecarReady(timeoutMs = 15_000) {
  return new Promise<SidecarEvent>((resolve, reject) => {
    const timer = setTimeout(() => {
      pendingStartResolver = null
      reject(new Error('Native capture helper timed out'))
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

async function startNativeCapture(
  getWindow: () => BrowserWindow | null,
  options: NativeCaptureStartOptions,
): Promise<NativeCaptureSession> {
  if (process.platform !== 'win32') {
    throw new Error('Native capture is only available on Windows')
  }

  getWindowRef = getWindow
  stopCaptureHelper()

  const sessionId = crypto.randomUUID()
  emitCaptureState(getWindow, { status: 'starting', sessionId })

  const helper = ensureCaptureHelper()
  const readyPromise = waitForSidecarReady()

  helper.stdin.write(
    `${JSON.stringify(buildCaptureStartCommand(options, getWindow))}\n`,
  )

  const readyEvent = await readyPromise
  if (readyEvent.type !== 'ready') {
    throw new Error('Native capture failed to start')
  }

  const streamMode = mapStreamMode(readyEvent.stream_mode)
  const encoder = mapEncoderBackend(readyEvent.encoder)
  const audioMode = mapAudioMode(readyEvent.audio_mode)

  activeSession = {
    sessionId,
    port: readyEvent.port,
    audioPort: readyEvent.audio_port,
    audioMode,
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

  const session: NativeCaptureSession = {
    sessionId,
    port: readyEvent.port,
    streamMode,
    encoder,
    audioPort: readyEvent.audio_port,
    audioMode,
  }

  emitCaptureState(getWindow, {
    status: 'running',
    sessionId,
    port: readyEvent.port,
  })

  return session
}

export function registerNativeCaptureIpc(getWindow: () => BrowserWindow | null) {
  if (captureIpcRegistered) return
  captureIpcRegistered = true
  getWindowRef = getWindow

  ipcMain.handle(
    IPC.captureStart,
    async (event, options: NativeCaptureStartOptions) => {
      if (!isTrustedSender(event, getWindow)) {
        throw new Error('Untrusted capture start request')
      }
      return startNativeCapture(getWindow, options)
    },
  )

  ipcMain.handle(IPC.captureStop, async (event, sessionId?: string) => {
    if (!isTrustedSender(event, getWindow)) return
    if (sessionId && activeSession?.sessionId !== sessionId) return
    stopCaptureHelper()
    emitCaptureState(getWindow, { status: 'idle' })
  })

  ipcMain.handle(
    IPC.capturePrepareSystemAudio,
    async (event, sourceId: string) => {
      if (!isTrustedSender(event, getWindow)) return
      rememberNativeAudioLoopbackSource(sourceId)
    },
  )

  ipcMain.handle(IPC.captureClearSystemAudio, async (event) => {
    if (!isTrustedSender(event, getWindow)) return
    clearNativeAudioLoopbackSource()
  })

  ipcMain.handle(
    IPC.captureReadSharedFrame,
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

  ipcMain.handle(IPC.captureGetState, async (event) => {
    if (!isTrustedSender(event, getWindow)) {
      return { status: 'idle' } satisfies NativeCaptureState
    }
    return captureState
  })

  ipcMain.handle(
    IPC.screenShareOpenNativePicker,
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

      win.webContents.send(IPC.screenShareRequest, request)
      return request
    },
  )
}

export function getActiveCaptureStats() {
  return activeSession
    ? {
        sessionId: activeSession.sessionId,
        methods: { ...activeSession.stats },
        activeMethod: activeSession.activeMethod,
      }
    : null
}
