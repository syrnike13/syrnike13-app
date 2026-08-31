import fs from 'node:fs'
import path from 'node:path'

import { app, utilityProcess, type UtilityProcess } from 'electron'

import { DESKTOP_RELEASE_CHANNEL } from '../desktop-app-identity'
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
  kill(): void
}

export type MediaUtilityAdapterFactory = () => MediaUtilityAdapter

type UtilityProcessLike =
  Pick<UtilityProcess, 'pid' | 'postMessage' | 'kill' | 'on'> & {
    stderr: NodeJS.ReadableStream | null
  }

export type ElectronMediaUtilityAdapterOptions = {
  utilityEntryPath: string
  nativeModulePath: string
  fork?: (
    modulePath: string,
    args: string[],
    options: Parameters<typeof utilityProcess.fork>[2],
  ) => UtilityProcessLike
}

export class ElectronMediaUtilityAdapter implements MediaUtilityAdapter {
  private child: UtilityProcessLike | null = null
  private killRequested = false
  private bootstrapTimer: ReturnType<typeof setInterval> | null = null

  constructor(private readonly options: ElectronMediaUtilityAdapterOptions) {}

  get pid() {
    return this.child?.pid
  }

  start(callbacks: MediaUtilityCallbacks) {
    if (this.child) throw new Error('Media utility process is already running')
    this.killRequested = false
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
      if (this.child === child) this.child = null
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
      try {
        child.kill()
      } catch {
        // The error is already terminal and the supervisor owns recovery.
      }
    })
    child.on('exit', (code) => finish('exit', code))
    child.on('spawn', () => {
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
    this.killRequested = true
    this.stopBootstrap()
    try {
      this.child?.kill()
    } catch {
      // Killing an already exited utility process is idempotent.
    }
    this.child = null
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
  return () => new ElectronMediaUtilityAdapter(resolveMediaUtilityPaths())
}
