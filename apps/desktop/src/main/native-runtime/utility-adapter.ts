import fs from 'node:fs'
import path from 'node:path'

import { app, utilityProcess, type UtilityProcess } from 'electron'

import { DESKTOP_RELEASE_CHANNEL } from '../desktop-app-identity'
import {
  NATIVE_RUNTIME_CONTRACT_VERSION,
  type NativeRuntimeKind,
  type NativeRuntimeRequest,
} from './contract'

const UTILITY_ENV_ALLOWLIST = [
  'APPDATA',
  'LOCALAPPDATA',
  'SystemRoot',
  'TEMP',
  'TMP',
  'USERPROFILE',
  'WINDIR',
] as const

export type NativeRuntimeAdapterExit = {
  code: number | null
  terminationSource?: 'error' | 'exit'
  uptimeMs?: number
  killRequested?: boolean
  stderrDrainTimedOut?: boolean
  signal?: string
  error?: Error
  stderrBytesSeen?: number
  stderrBytesCaptured?: number
  stderrTruncated?: boolean
}

export type NativeRuntimeAdapterCallbacks = {
  onMessage(message: unknown): void
  onExit(exit: NativeRuntimeAdapterExit): void
}

export interface NativeRuntimeAdapter {
  readonly pid: number | undefined
  start(callbacks: NativeRuntimeAdapterCallbacks): void
  postMessage(message: NativeRuntimeRequest): void
  kill(): void
}

export type NativeRuntimeAdapterFactory = () => NativeRuntimeAdapter

type UtilityProcessLike =
  Pick<UtilityProcess, 'pid' | 'postMessage' | 'kill' | 'on'> & {
    stderr: NodeJS.ReadableStream | null
  }

export type ElectronUtilityAdapterOptions = {
  runtime: NativeRuntimeKind
  utilityEntryPath: string
  nativeModulePath: string
  fork?: (
    modulePath: string,
    args: string[],
    options: Parameters<typeof utilityProcess.fork>[2],
  ) => UtilityProcessLike
}

export class ElectronUtilityAdapter implements NativeRuntimeAdapter {
  private child: UtilityProcessLike | null = null
  private killRequested = false

  constructor(private readonly options: ElectronUtilityAdapterOptions) {}

  get pid() {
    return this.child?.pid
  }

  start(callbacks: NativeRuntimeAdapterCallbacks) {
    if (this.child) throw new Error('Native utility process is already running')
    const fork = this.options.fork ?? utilityProcess.fork
    this.killRequested = false
    const startedAt = Date.now()
    const child = fork(this.options.utilityEntryPath, [], {
      serviceName: `syrnike-${this.options.runtime}-runtime`,
      stdio: ['ignore', 'ignore', 'pipe'],
      env: nativeUtilityEnvironment({
        nativeRoot: path.dirname(this.options.nativeModulePath),
        SYRNIKE_NATIVE_RUNTIME_KIND: this.options.runtime,
        SYRNIKE_NATIVE_MODULE_PATH: this.options.nativeModulePath,
      }),
    })
    this.child = child

    const stderr = new BoundedByteTail()
    const stderrStream = child.stderr as
      | (NodeJS.ReadableStream & { readableEnded?: boolean })
      | null
    stderrStream?.on('data', (chunk) => stderr.append(chunk))

    let terminal = false
    const finish = (
      exit: NativeRuntimeAdapterExit,
      terminationSource: 'error' | 'exit',
      terminate = false,
    ) => {
      if (terminal) return
      terminal = true
      if (this.child === child) this.child = null
      if (terminate) {
        try {
          child.kill()
        } catch {
          // The error event is already terminal; the supervisor still recovers.
        }
      }
      let finalized = false
      let drainTimer: ReturnType<typeof setTimeout> | null = null
      const finalize = (stderrDrainTimedOut = false) => {
        if (finalized) return
        finalized = true
        if (drainTimer) clearTimeout(drainTimer)
        stderrStream?.removeListener('end', finalize)
        const stderrSnapshot = stderr.snapshot()
        callbacks.onExit({
          ...exit,
          terminationSource,
          uptimeMs: Math.max(0, Date.now() - startedAt),
          killRequested: this.killRequested,
          stderrDrainTimedOut,
          stderrBytesSeen: stderrSnapshot.bytesSeen,
          stderrBytesCaptured: stderrSnapshot.value.byteLength,
          stderrTruncated: stderrSnapshot.truncated,
        })
      }
      if (!stderrStream || stderrStream.readableEnded) {
        finalize()
        return
      }
      stderrStream.once('end', finalize)
      drainTimer = setTimeout(() => finalize(true), STDERR_DRAIN_GRACE_MS)
      drainTimer.unref?.()
    }

    child.on('message', callbacks.onMessage)
    child.on('error', (error) => {
      finish({ code: null, error: new Error(String(error)) }, 'error', true)
    })
    child.on('exit', (code) => finish({ code }, 'exit'))
  }

  postMessage(message: NativeRuntimeRequest) {
    if (!this.child) throw new Error('Native utility process is not running')
    this.child.postMessage(message)
  }

  kill() {
    this.killRequested = true
    try {
      this.child?.kill()
    } catch {
      // Killing an already exited utility process is idempotent.
    }
    this.child = null
  }
}

const MAX_STDERR_TAIL_BYTES = 16 * 1024
const STDERR_DRAIN_GRACE_MS = 100

export class BoundedByteTail {
  private value = Buffer.alloc(0)
  private bytesSeen = 0

  constructor(private readonly maximumBytes = MAX_STDERR_TAIL_BYTES) {}

  append(chunk: unknown) {
    const next = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk))
    this.bytesSeen += next.byteLength
    if (this.maximumBytes <= 0) return
    if (next.byteLength >= this.maximumBytes) {
      this.value = Buffer.from(next.subarray(next.byteLength - this.maximumBytes))
      return
    }
    const keepFromCurrent = Math.min(
      this.value.byteLength,
      this.maximumBytes - next.byteLength,
    )
    this.value = Buffer.concat([
      this.value.subarray(this.value.byteLength - keepFromCurrent),
      next,
    ])
  }

  snapshot() {
    return {
      value: Buffer.from(this.value),
      bytesSeen: this.bytesSeen,
      truncated: this.bytesSeen > this.value.byteLength,
    }
  }
}

function nativeUtilityEnvironment(
  native: Record<string, string> & { nativeRoot: string },
) {
  const env: NodeJS.ProcessEnv = {}
  for (const key of UTILITY_ENV_ALLOWLIST) {
    const value = process.env[key]
    if (value) env[key] = value
  }
  const { nativeRoot, ...provided } = native
  return {
    ...env,
    ...provided,
    SYRNIKE_NATIVE_ROOT: nativeRoot,
    SYRNIKE_NATIVE_APP_VERSION: app.getVersion(),
    SYRNIKE_NATIVE_RELEASE_CHANNEL: DESKTOP_RELEASE_CHANNEL,
    SYRNIKE_NATIVE_CONTRACT_VERSION: String(NATIVE_RUNTIME_CONTRACT_VERSION),
    SYRNIKE_NATIVE_COMMIT_SHA: __DESKTOP_COMMIT_SHA__,
  }
}

export function resolveNativeRuntimePaths(runtime: NativeRuntimeKind) {
  const utilityEntryPath = path.resolve(
    app.getAppPath(),
    'out',
    'utility',
    `${runtime}-host.cjs`,
  )
  const nativeRoot = app.isPackaged
    ? path.join(process.resourcesPath, 'native', 'win32-x64')
    : path.resolve(app.getAppPath(), 'out', 'native', 'win32-x64')
  return {
    utilityEntryPath,
    nativeModulePath: path.join(nativeRoot, `syrnike_${runtime}.node`),
  }
}

export function nativeRuntimeAvailable(runtime: NativeRuntimeKind) {
  if (process.platform !== 'win32') return false
  const paths = resolveNativeRuntimePaths(runtime)
  return fs.existsSync(paths.utilityEntryPath) && fs.existsSync(paths.nativeModulePath)
}

export function createElectronUtilityAdapterFactory(
  runtime: NativeRuntimeKind,
): NativeRuntimeAdapterFactory {
  return () =>
    new ElectronUtilityAdapter({ runtime, ...resolveNativeRuntimePaths(runtime) })
}
