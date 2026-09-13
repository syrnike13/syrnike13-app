import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'

import { app, utilityProcess, type UtilityProcess } from 'electron'

import { DESKTOP_RELEASE_CHANNEL } from '../desktop-app-identity'
import { verifyMediaArtifactDistribution } from './media-artifacts'
import {
  MEDIA_LIFECYCLE_PROTOCOL_VERSION,
  MEDIA_UTILITY_BOOTSTRAP_MESSAGE,
  type MediaLifecycleRequest,
} from './contract'

const MEDIA_UTILITY_ENV_ALLOWLIST = [
  'APPDATA',
  'LOCALAPPDATA',
  'SystemRoot',
  'TEMP',
  'TMP',
  'USERPROFILE',
  'WINDIR',
] as const

export type MediaUtilityExit = {
  code: number | null
  source: 'error' | 'exit'
  expected: boolean
  uptimeMs: number
  stderr: string
  stderrTruncated: boolean
  error?: Error
}

export type MediaUtilityCallbacks = {
  onMessage(message: unknown): void
  onExit(exit: MediaUtilityExit): void
}

export interface MediaUtilityAdapter {
  readonly pid: number | undefined
  start(callbacks: MediaUtilityCallbacks): void
  postMessage(message: MediaLifecycleRequest): void
  kill(): Promise<void>
}

export type MediaUtilityAdapterFactory = () => MediaUtilityAdapter

type UtilityProcessLike =
  Pick<UtilityProcess, 'pid' | 'postMessage' | 'kill' | 'on'> & {
    stderr: NodeJS.ReadableStream | null
  }

export type ElectronMediaUtilityAdapterOptions = {
  utilityEntryPath: string
  nativeModulePath: string
  openProcess?: (pid: number) => UtilityProcessGuard
  fork?: (
    modulePath: string,
    args: string[],
    options: Parameters<typeof utilityProcess.fork>[2],
  ) => UtilityProcessLike
}

type UtilityProcessGuard = {
  terminate(): void
  hasExited(): boolean
  close(): void
}

type NativeProcessBroker = {
  openUtilityProcess(pid: number): unknown
  armProcessExitDeadline(timeoutMs: number): void
}

let processBroker: NativeProcessBroker | null = null

export function armMediaProcessExitDeadline(timeoutMs: number) {
  // Load and verify the broker before starting media, never during shutdown.
  // Retain it after utility retirement so late Electron/Node exit is bounded too.
  processBroker?.armProcessExitDeadline(timeoutMs)
}

function isNativeProcessBroker(value: unknown): value is NativeProcessBroker {
  return typeof value === 'object' && value !== null &&
    typeof Reflect.get(value, 'openUtilityProcess') === 'function' &&
    typeof Reflect.get(value, 'armProcessExitDeadline') === 'function'
}

function loadProcessGuard(nativeModulePath: string): (pid: number) => UtilityProcessGuard {
  verifyMediaArtifactDistribution(path.dirname(nativeModulePath), {
    appVersion: app.getVersion(), commitSha: __DESKTOP_COMMIT_SHA__,
    electronVersion: process.versions.electron ?? '', releaseChannel: DESKTOP_RELEASE_CHANNEL,
  })
  const filename = path.join(path.dirname(nativeModulePath), 'windows_media_texture_broker.node')
  const loaded: unknown = createRequire(filename)(filename)
  if (!isNativeProcessBroker(loaded)) {
    throw new Error('Invalid utility process broker')
  }
  processBroker = loaded
  return (pid) => {
    const guard = loaded.openUtilityProcess(pid)
    if (!isProcessGuard(guard)) throw new Error('Invalid utility process guard')
    return guard
  }
}

function isProcessGuard(value: unknown): value is UtilityProcessGuard {
  return typeof value === 'object' && value !== null &&
    ['terminate', 'hasExited', 'close'].every(key => typeof Reflect.get(value, key) === 'function')
}

export class ElectronMediaUtilityAdapter implements MediaUtilityAdapter {
  private child: UtilityProcessLike | null = null
  private killRequested = false
  private bootstrapTimer: ReturnType<typeof setInterval> | null = null
  private processGuard: UtilityProcessGuard | null = null
  private termination: Promise<void> | null = null
  private exited = false

  constructor(private readonly options: ElectronMediaUtilityAdapterOptions) {}

  get pid() {
    return this.child?.pid
  }

  start(callbacks: MediaUtilityCallbacks) {
    if (this.child) throw new Error('Media utility process is already running')
    this.killRequested = false
    this.exited = false
    const openProcess = this.options.openProcess ?? loadProcessGuard(this.options.nativeModulePath)
    const startedAt = Date.now()
    const fork = this.options.fork ?? utilityProcess.fork
    const child = fork(this.options.utilityEntryPath, [], {
      serviceName: 'syrnike-windows-media-lifecycle',
      stdio: ['ignore', 'ignore', 'pipe'],
      env: mediaUtilityEnvironment(path.dirname(this.options.nativeModulePath), {
        SYRNIKE_MEDIA_MODULE_PATH: this.options.nativeModulePath,
      }),
    })
    this.child = child
    const stderr = new MediaStderrTail()
    child.stderr?.on('data', (chunk) => stderr.append(chunk))
    let terminal = false
    const finish = (
      source: MediaUtilityExit['source'],
      code: number | null,
      error?: Error,
    ) => {
      if (terminal) return
      terminal = true
      this.stopBootstrap()
      const snapshot = stderr.snapshot()
      callbacks.onExit({
        code,
        source,
        expected: this.killRequested,
        uptimeMs: Math.max(0, Date.now() - startedAt),
        stderr: snapshot.value,
        stderrTruncated: snapshot.truncated,
        error,
      })
    }
    child.on('message', (message) => {
      this.stopBootstrap()
      callbacks.onMessage(message)
    })
    child.on('error', (error) => {
      finish('error', null, new Error(String(error)))
    })
    child.on('exit', (code) => {
      this.exited = true
      this.processGuard?.close()
      this.processGuard = null
      if (this.child === child) this.child = null
      finish('exit', code)
    })
    child.on('spawn', () => {
      try {
        if (!child.pid) throw new Error('Utility spawned without a PID')
        this.processGuard = openProcess(child.pid)
        if (this.killRequested) {
          this.processGuard.terminate()
          return
        }
      } catch (cause) {
        finish('error', null, cause instanceof Error ? cause : new Error(String(cause)))
        return
      }
      const bootstrap = () => {
        try {
          child.postMessage(MEDIA_UTILITY_BOOTSTRAP_MESSAGE)
        } catch {
          // An exit/error event owns terminal reporting.
        }
      }
      this.bootstrapTimer = setInterval(bootstrap, 25)
      this.bootstrapTimer.unref?.()
      bootstrap()
    })
  }

  postMessage(message: MediaLifecycleRequest) {
    if (!this.child) throw new Error('Media utility process is not running')
    this.child.postMessage(message)
  }

  kill() {
    if (this.termination) return this.termination
    this.killRequested = true
    this.stopBootstrap()
    this.termination = this.terminateProcess()
    return this.termination
  }

  private async terminateProcess() {
    if (!this.child || this.exited) return
    if (this.processGuard) this.processGuard.terminate()
    else this.child.kill()
    const deadline = Date.now() + 2_000
    while (!this.exited) {
      if (this.processGuard?.hasExited()) {
        this.processGuard.close()
        this.processGuard = null
        this.child = null
        this.exited = true
        return
      }
      if (Date.now() >= deadline) throw new Error('Utility process termination exceeded its deadline')
      await new Promise<void>(resolve => setTimeout(resolve, 10))
    }
  }

  private stopBootstrap() {
    if (this.bootstrapTimer) clearInterval(this.bootstrapTimer)
    this.bootstrapTimer = null
  }
}

const MAX_MEDIA_STDERR_BYTES = 16 * 1_024

class MediaStderrTail {
  private value = Buffer.alloc(0)
  private bytesSeen = 0

  append(chunk: unknown) {
    const next = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk))
    this.bytesSeen += next.byteLength
    if (next.byteLength >= MAX_MEDIA_STDERR_BYTES) {
      this.value = Buffer.from(
        next.subarray(next.byteLength - MAX_MEDIA_STDERR_BYTES),
      )
      return
    }
    const retained = Math.min(
      this.value.byteLength,
      MAX_MEDIA_STDERR_BYTES - next.byteLength,
    )
    this.value = Buffer.concat([
      this.value.subarray(this.value.byteLength - retained),
      next,
    ])
  }

  snapshot() {
    return {
      value: this.value.toString('utf8'),
      truncated: this.bytesSeen > this.value.byteLength,
    }
  }
}

function mediaUtilityEnvironment(
  mediaRoot: string,
  provided: Record<string, string>,
) {
  const env: NodeJS.ProcessEnv = {}
  for (const key of MEDIA_UTILITY_ENV_ALLOWLIST) {
    const value = process.env[key]
    if (value) env[key] = value
  }
  return {
    ...env,
    ...provided,
    SYRNIKE_MEDIA_ROOT: mediaRoot,
    SYRNIKE_MEDIA_APP_VERSION: app.getVersion(),
    SYRNIKE_MEDIA_RELEASE_CHANNEL: DESKTOP_RELEASE_CHANNEL,
    SYRNIKE_MEDIA_PROTOCOL_VERSION: String(MEDIA_LIFECYCLE_PROTOCOL_VERSION),
    SYRNIKE_MEDIA_COMMIT_SHA: __DESKTOP_COMMIT_SHA__,
  }
}

export function resolveMediaUtilityPaths() {
  const utilityEntryPath = path.resolve(
    app.getAppPath(),
    'out',
    'utility',
    'media-host.cjs',
  )
  const mediaRoot = app.isPackaged
    ? path.join(process.resourcesPath, 'media-engine', 'win32-x64')
    : path.resolve(app.getAppPath(), 'out', 'media-native', 'win32-x64')
  return {
    utilityEntryPath,
    nativeModulePath: path.join(mediaRoot, 'windows_media.node'),
  }
}

export function mediaUtilityAvailable() {
  if (process.platform !== 'win32') return false
  const paths = resolveMediaUtilityPaths()
  return (
    fs.existsSync(paths.utilityEntryPath) &&
    fs.existsSync(paths.nativeModulePath) &&
    fs.existsSync(path.join(path.dirname(paths.nativeModulePath), 'media-manifest.json'))
  )
}

export function createElectronMediaUtilityAdapterFactory(): MediaUtilityAdapterFactory {
  const paths = resolveMediaUtilityPaths()
  let openProcess: ((pid: number) => UtilityProcessGuard) | undefined
  return () => {
    // The native broker stays loaded in main. Verify it once before loading,
    // avoiding synchronous DLL hashing during an active media recovery.
    openProcess ??= loadProcessGuard(paths.nativeModulePath)
    return new ElectronMediaUtilityAdapter({ ...paths, openProcess })
  }
}
