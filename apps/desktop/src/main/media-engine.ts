import { spawn, type ChildProcess } from 'node:child_process'
import fs from 'node:fs'
import net from 'node:net'
import path from 'node:path'
import { app, type BrowserWindow } from 'electron'
import {
  IPC,
  type MediaEngineEvent,
  type MediaEnginePingResult,
  type MediaEngineRoomConnectParams,
  type MediaEngineRoomConnectResult,
  type MediaEngineRuntimeStatus,
  type MediaEngineScreenStartParams,
  type MediaEngineScreenStartResult,
} from '@syrnike13/platform'

import {
  createMediaEngineRequest,
  parseMediaEngineLine,
} from './media-engine-protocol'

const PIPE_PREFIX = 'syrnike-media'
const REQUEST_TIMEOUT_MS = 30_000
const HEALTH_PING_INTERVAL_MS = 5_000
const MAX_RESTART_ATTEMPTS = 3

type PendingRequest = {
  resolve: (value: unknown) => void
  reject: (error: Error) => void
  timer: NodeJS.Timeout
}

let engineProcess: ChildProcess | null = null
let controlSocket: net.Socket | null = null
let getWindowRef: (() => BrowserWindow | null) | null = null
let runtimeStatus: MediaEngineRuntimeStatus = 'not-running'
let requestCounter = 0
let restartAttempts = 0
let intentionalShutdown = false
let healthTimer: NodeJS.Timeout | null = null
let connecting: Promise<void> | null = null

const pendingRequests = new Map<number, PendingRequest>()

export function initializeMediaEngine(getWindow: () => BrowserWindow | null) {
  getWindowRef = getWindow

  if (process.platform !== 'win32') {
    runtimeStatus = 'unsupported-platform'
    return
  }

  void ensureEngineRunning().catch((error) => {
    runtimeStatus = 'error'
    console.error('[media-engine] failed to start', error)
  })
}

export function getMediaEngineRuntimeStatus() {
  return runtimeStatus
}

export async function pingMediaEngine(): Promise<MediaEnginePingResult> {
  return (await sendRequest('engine.ping', {})) as MediaEnginePingResult
}

export async function connectMediaEngineRoom(
  params: MediaEngineRoomConnectParams,
): Promise<MediaEngineRoomConnectResult> {
  return (await sendRequest('room.connect', params)) as MediaEngineRoomConnectResult
}

export async function disconnectMediaEngineRoom(): Promise<void> {
  await sendRequest('room.disconnect', {})
}

export async function publishMediaEngineTestTone(): Promise<void> {
  await sendRequest('room.publishTestTone', {})
}

export async function micSetEnabledMediaEngine(enabled: boolean) {
  return (await sendRequest('mic.setEnabled', { enabled })) as {
    enabled: boolean
  }
}

export async function startMediaEngineScreen(
  getWindow: () => BrowserWindow | null,
  params: MediaEngineScreenStartParams,
): Promise<MediaEngineScreenStartResult> {
  const win = getWindow()
  let selfWindowHwnd: number | undefined
  if (win && !win.isDestroyed()) {
    const handle = win.getNativeWindowHandle()
    selfWindowHwnd =
      handle.length >= 8
        ? Number(handle.readBigInt64LE())
        : handle.readInt32LE(0)
  }

  const result = (await sendRequest('screen.start', {
    ...params,
    excludeProcessId: process.pid,
    selfWindowHwnd,
  })) as MediaEngineScreenStartResult

  emitEngineEvent({
    event: 'screen.started',
    params: result,
  })

  return result
}

export async function stopMediaEngineScreen(): Promise<void> {
  await sendRequest('screen.stop', {})
  emitEngineEvent({
    event: 'screen.stopped',
    params: {},
  })
}

export function disposeMediaEngine() {
  intentionalShutdown = true
  stopHealthChecks()
  rejectAllPending(new Error('media engine disposed'))

  controlSocket?.destroy()
  controlSocket = null

  if (engineProcess && !engineProcess.killed) {
    void sendRequest('engine.shutdown', {}).catch(() => {
      engineProcess?.kill()
    })
    setTimeout(() => {
      engineProcess?.kill()
    }, 500).unref()
  }

  engineProcess = null
  runtimeStatus = 'not-running'
  getWindowRef = null
  connecting = null
}

async function ensureEngineRunning() {
  if (runtimeStatus === 'unsupported-platform') return
  if (controlSocket && !controlSocket.destroyed) return
  if (connecting) {
    await connecting
    return
  }

  connecting = startEngine()
  try {
    await connecting
  } finally {
    connecting = null
  }
}

async function startEngine() {
  runtimeStatus = 'starting'

  const executable = resolveEnginePath()
  if (!executable) {
    runtimeStatus = 'error'
    throw new Error('syrnike-media-engine-win.exe was not found')
  }

  const pipeName = `${PIPE_PREFIX}-${process.pid}`
  const pipePath = `\\\\.\\pipe\\${pipeName}`

  engineProcess = spawn(
    executable,
    ['--parent-pid', String(process.pid)],
    {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    },
  )

  const readyPromise = waitForReadyEvent(pipeName)
  attachProcessLogging(engineProcess!)
  await readyPromise
  await connectControlSocket(pipePath)

  runtimeStatus = 'running'
  restartAttempts = 0
  startHealthChecks()
}

function attachProcessLogging(process: ChildProcess) {
  process.stdout?.on('data', (chunk: Buffer) => {
    for (const line of chunk.toString('utf8').split(/\r?\n/)) {
      handleEngineLine(line)
    }
  })

  process.stderr?.on('data', (chunk: Buffer) => {
    const message = chunk.toString('utf8').trim()
    if (message) console.warn('[media-engine]', message)
  })

  process.once('exit', (code) => {
    readyWaiter?.reject(
      new Error(`media engine exited before ready (code=${code})`),
    )
  })

  process.on('exit', (code, signal) => {
    controlSocket?.destroy()
    controlSocket = null
    engineProcess = null
    rejectAllPending(new Error(`media engine exited (code=${code}, signal=${signal})`))

    if (intentionalShutdown) {
      runtimeStatus = 'not-running'
      return
    }

    runtimeStatus = 'error'
    emitEngineEvent({
      event: 'engine.crashed',
      params: {
        message: `media engine exited (code=${code ?? 'null'}, signal=${signal ?? 'null'})`,
      },
    })

    if (restartAttempts < MAX_RESTART_ATTEMPTS) {
      restartAttempts += 1
      emitEngineEvent({
        event: 'engine.restarted',
        params: { attempt: restartAttempts },
      })
      setTimeout(() => {
        void ensureEngineRunning().catch((error) => {
          console.error('[media-engine] restart failed', error)
        })
      }, 500).unref()
    }
  })
}

let readyWaiter:
  | {
      expectedPipe: string
      resolve: () => void
      reject: (error: Error) => void
      timeout: NodeJS.Timeout
    }
  | null = null

function waitForReadyEvent(expectedPipe: string) {
  return new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      readyWaiter = null
      reject(new Error('media engine ready event timed out'))
    }, 15_000)

    readyWaiter = {
      expectedPipe,
      resolve: () => {
        clearTimeout(timeout)
        readyWaiter = null
        resolve()
      },
      reject: (error) => {
        clearTimeout(timeout)
        readyWaiter = null
        reject(error)
      },
      timeout,
    }
  })
}

async function connectControlSocket(pipePath: string) {
  await new Promise<void>((resolve, reject) => {
    const socket = net.connect(pipePath)
    controlSocket = socket

    socket.once('connect', () => resolve())
    socket.once('error', (error) => reject(error))

    socket.on('data', (chunk) => {
      for (const line of chunk.toString('utf8').split(/\r?\n/)) {
        handleEngineLine(line)
      }
    })

    socket.on('close', () => {
      if (controlSocket === socket) controlSocket = null
    })
  })
}

function handleEngineLine(line: string) {
  const parsed = parseMediaEngineLine(line)
  if (!parsed) return

  if (parsed.kind === 'response') {
    const pending = pendingRequests.get(parsed.message.id)
    if (!pending) return

    clearTimeout(pending.timer)
    pendingRequests.delete(parsed.message.id)

    if (parsed.message.ok) {
      pending.resolve(parsed.message.result)
      return
    }

    pending.reject(
      new Error(
        parsed.message.error?.message ??
          `media engine request failed (${parsed.message.error?.code ?? 'UNKNOWN'})`,
      ),
    )
    return
  }

  const event = parsed.message as MediaEngineEvent
  if (parsed.kind === 'event' && event.event !== 'engine.ready') {
    emitEngineEvent(event)
    return
  }

  if (
    readyWaiter &&
    event.event === 'engine.ready' &&
    typeof event.params.pipe === 'string'
  ) {
    if (event.params.pipe !== readyWaiter.expectedPipe) {
      readyWaiter.reject(
        new Error(`unexpected media engine pipe: ${event.params.pipe}`),
      )
    } else {
      readyWaiter.resolve()
    }
  }

  emitEngineEvent(event)
}

async function sendRequest(method: string, params: unknown) {
  await ensureEngineRunning()

  if (!controlSocket || controlSocket.destroyed) {
    throw new Error('media engine control socket is not connected')
  }

  const id = ++requestCounter

  return new Promise<unknown>((resolve, reject) => {
    const timer = setTimeout(() => {
      pendingRequests.delete(id)
      reject(new Error(`media engine request timed out: ${method}`))
    }, REQUEST_TIMEOUT_MS)

    pendingRequests.set(id, {
      resolve,
      reject,
      timer,
    })

    controlSocket?.write(createMediaEngineRequest(id, method, params), (error) => {
      if (!error) return

      clearTimeout(timer)
      pendingRequests.delete(id)
      reject(error)
    })
  })
}

function emitEngineEvent(event: MediaEngineEvent) {
  const window = getWindowRef?.()
  window?.webContents.send(IPC.mediaEngineEvent, event)
}

function startHealthChecks() {
  stopHealthChecks()
  healthTimer = setInterval(() => {
    void pingMediaEngine().catch((error) => {
      console.warn('[media-engine] health ping failed', error)
    })
  }, HEALTH_PING_INTERVAL_MS)
  healthTimer.unref()
}

function stopHealthChecks() {
  if (!healthTimer) return
  clearInterval(healthTimer)
  healthTimer = null
}

function rejectAllPending(error: Error) {
  for (const [id, pending] of pendingRequests.entries()) {
    clearTimeout(pending.timer)
    pending.reject(error)
    pendingRequests.delete(id)
  }
}

function resolveEnginePath() {
  const fileName = 'syrnike-media-engine-win.exe'
  const candidates = [
    path.join(app.getAppPath(), 'out', 'native', fileName),
    path.join(process.cwd(), 'apps', 'desktop', 'out', 'native', fileName),
    path.join(
      process.cwd(),
      'apps',
      'desktop',
      'native',
      'media-engine-win',
      'target',
      'release',
      fileName,
    ),
    path.join(
      process.cwd(),
      'apps',
      'desktop',
      'native',
      'media-engine-win',
      'target',
      'debug',
      fileName,
    ),
  ]

  if (app.isPackaged) {
    candidates.unshift(path.join(process.resourcesPath, 'native', fileName))
  }

  return candidates.find((candidate) => fs.existsSync(candidate)) ?? null
}
