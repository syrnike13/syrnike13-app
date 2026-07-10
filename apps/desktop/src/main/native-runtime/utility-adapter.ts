import fs from 'node:fs'
import path from 'node:path'

import { app, utilityProcess, type UtilityProcess } from 'electron'

import { DESKTOP_RELEASE_CHANNEL } from '../desktop-app-identity'
import { NATIVE_RUNTIME_LIVEKIT_VERSION } from './native-artifacts'
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
  signal?: string
  error?: Error
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

type UtilityProcessLike = Pick<UtilityProcess, 'pid' | 'postMessage' | 'kill' | 'on'>

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

  constructor(private readonly options: ElectronUtilityAdapterOptions) {}

  get pid() {
    return this.child?.pid
  }

  start(callbacks: NativeRuntimeAdapterCallbacks) {
    if (this.child) throw new Error('Native utility process is already running')
    const fork = this.options.fork ?? utilityProcess.fork
    const child = fork(this.options.utilityEntryPath, [], {
      serviceName: `syrnike-${this.options.runtime}-runtime`,
      // Native logging must never be able to fill an unread pipe and stall the
      // runtime. Structured events are the only supported host -> main seam.
      stdio: 'ignore',
      env: nativeUtilityEnvironment({
        nativeRoot: path.dirname(this.options.nativeModulePath),
        SYRNIKE_NATIVE_RUNTIME_KIND: this.options.runtime,
        SYRNIKE_NATIVE_MODULE_PATH: this.options.nativeModulePath,
      }),
    })
    this.child = child
    let terminal = false
    const finish = (exit: NativeRuntimeAdapterExit, terminate = false) => {
      if (terminal) return
      terminal = true
      if (this.child === child) this.child = null
      if (terminate) {
        try {
          child.kill()
        } catch {
          // The error event is already terminal; the supervisor must still recover.
        }
      }
      callbacks.onExit(exit)
    }
    child.on('message', callbacks.onMessage)
    child.on('error', (error) => {
      finish(
        {
          code: null,
          error: new Error(String(error)),
        },
        true,
      )
    })
    child.on('exit', (code) => {
      finish({ code })
    })
  }

  postMessage(message: NativeRuntimeRequest) {
    if (!this.child) throw new Error('Native utility process is not running')
    this.child.postMessage(message)
  }

  kill() {
    try {
      this.child?.kill()
    } catch {
      // Killing an already exited Electron utility process is idempotent here.
    }
    this.child = null
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
    SYRNIKE_NATIVE_LIVEKIT_VERSION: NATIVE_RUNTIME_LIVEKIT_VERSION,
    SYRNIKE_NATIVE_COMMIT_SHA: __DESKTOP_COMMIT_SHA__,
  }
}

export function resolveNativeRuntimePaths(runtime: NativeRuntimeKind) {
  const utilityFilename = runtime === 'media' ? 'media-host.cjs' : 'hooks-host.cjs'
  const nativeFilename = runtime === 'media' ? 'syrnike_media.node' : 'syrnike_hooks.node'
  const utilityEntryPath = path.resolve(
    app.getAppPath(),
    'out',
    'utility',
    utilityFilename,
  )
  const nativeRoot = app.isPackaged
    ? path.join(process.resourcesPath, 'native', 'win32-x64')
    : path.resolve(app.getAppPath(), 'out', 'native', 'win32-x64')
  const nativeModulePath = path.join(nativeRoot, nativeFilename)
  return { utilityEntryPath, nativeModulePath }
}

export function nativeRuntimeAvailable(runtime: NativeRuntimeKind) {
  if (process.platform !== 'win32') return false
  const paths = resolveNativeRuntimePaths(runtime)
  return fs.existsSync(paths.utilityEntryPath) && fs.existsSync(paths.nativeModulePath)
}

export function createElectronUtilityAdapterFactory(
  runtime: NativeRuntimeKind,
): NativeRuntimeAdapterFactory {
  return () => {
    const paths = resolveNativeRuntimePaths(runtime)
    return new ElectronUtilityAdapter({ runtime, ...paths })
  }
}
