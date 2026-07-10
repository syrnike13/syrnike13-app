import fs from 'node:fs'
import path from 'node:path'

import { app, utilityProcess, type UtilityProcess } from 'electron'

import { DESKTOP_RELEASE_CHANNEL } from '../desktop-app-identity'
import {
  createNativeDiagnosticLog,
  createNativeDiagnosticSession,
  type NativeDiagnosticLog,
  type NativeDiagnosticSession,
} from './diagnostic-log'
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
  diagnosticSession?: NativeDiagnosticSession
  diagnosticLog?: NativeDiagnosticLog
  diagnosticRootDir?: string
  fork?: (
    modulePath: string,
    args: string[],
    options: Parameters<typeof utilityProcess.fork>[2],
  ) => UtilityProcessLike
}

export class ElectronUtilityAdapter implements NativeRuntimeAdapter {
  private child: UtilityProcessLike | null = null
  private diagnosticLog: NativeDiagnosticLog | null = null
  private ownsDiagnosticLog = false

  constructor(private readonly options: ElectronUtilityAdapterOptions) {}

  get pid() {
    return this.child?.pid
  }

  start(callbacks: NativeRuntimeAdapterCallbacks) {
    if (this.child) throw new Error('Native utility process is already running')
    const fork = this.options.fork ?? utilityProcess.fork
    const diagnosticSession =
      this.options.runtime === 'media'
        ? this.options.diagnosticSession ??
          maybeCreateNativeDiagnosticSession(
            this.options.runtime,
            this.options.diagnosticRootDir,
          )
        : undefined
    const env = nativeUtilityEnvironment({
      nativeRoot: path.dirname(this.options.nativeModulePath),
      SYRNIKE_NATIVE_RUNTIME_KIND: this.options.runtime,
      SYRNIKE_NATIVE_MODULE_PATH: this.options.nativeModulePath,
      ...(diagnosticSession
        ? {
            SYRNIKE_NATIVE_DIAGNOSTIC_RUN_ID: diagnosticSession.runId,
            SYRNIKE_NATIVE_UTILITY_LOG_PATH: diagnosticSession.paths.utilityPath,
            SYRNIKE_NATIVE_MEDIA_LOG_PATH: diagnosticSession.paths.nativePath,
          }
        : {}),
    })
    this.diagnosticLog =
      this.options.diagnosticLog ??
      (diagnosticSession
        ? createNativeDiagnosticLog({
          runtime: this.options.runtime,
          role: 'electron-main',
          runId: diagnosticSession.runId,
          directory: diagnosticSession.directory,
          latestPath: diagnosticSession.latestPath,
          filePath: diagnosticSession.paths.electronMainPath,
          paths: diagnosticSession.paths,
        })
        : null)
    this.ownsDiagnosticLog = Boolean(
      this.diagnosticLog && !this.options.diagnosticLog,
    )
    this.diagnosticLog?.log('transport_spawn', {
      utilityEntryFile: path.basename(this.options.utilityEntryPath),
      nativeModuleFile: path.basename(this.options.nativeModulePath),
      utilityLogFile: diagnosticSession
        ? path.basename(diagnosticSession.paths.utilityPath)
        : undefined,
      nativeLogFile: diagnosticSession
        ? path.basename(diagnosticSession.paths.nativePath)
        : undefined,
    })
    const child = fork(this.options.utilityEntryPath, [], {
      serviceName: `syrnike-${this.options.runtime}-runtime`,
      // Native logging must never be able to fill an unread pipe and stall the
      // runtime. Structured events are the only supported host -> main seam.
      stdio: 'ignore',
      env,
    })
    this.child = child
    this.diagnosticLog?.log('transport_started', {
      adapterPid: child.pid,
    })
    let terminal = false
    const finish = (exit: NativeRuntimeAdapterExit, terminate = false) => {
      if (terminal) return
      terminal = true
      if (this.child === child) this.child = null
      this.diagnosticLog?.log('transport_exit', {
        adapterPid: child.pid,
        code: exit.code,
        signal: exit.signal,
        error: exit.error?.message,
        terminate,
      })
      if (terminate) {
        try {
          child.kill()
        } catch {
          // The error event is already terminal; the supervisor must still recover.
        }
      }
      this.releaseDiagnosticLog()
      callbacks.onExit(exit)
    }
    child.on('message', (message) => {
      if (!isMicrophoneMetricsTransportMessage(message)) {
        this.diagnosticLog?.log('transport_message', message)
      }
      callbacks.onMessage(message)
    })
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
    this.diagnosticLog?.log('transport_post', message)
    this.child.postMessage(message)
  }

  kill() {
    try {
      this.diagnosticLog?.log('transport_kill')
      this.child?.kill()
    } catch {
      // Killing an already exited Electron utility process is idempotent here.
    }
    this.child = null
    this.releaseDiagnosticLog()
  }

  private releaseDiagnosticLog() {
    if (this.ownsDiagnosticLog) void this.diagnosticLog?.close()
    this.diagnosticLog = null
    this.ownsDiagnosticLog = false
  }
}

function isMicrophoneMetricsTransportMessage(message: unknown) {
  if (!message || typeof message !== 'object') return false
  const envelope = message as { type?: unknown; event?: unknown }
  if (
    envelope.type !== 'event' ||
    !envelope.event ||
    typeof envelope.event !== 'object'
  ) {
    return false
  }
  return (envelope.event as { type?: unknown }).type === 'microphoneMetrics'
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
  diagnostics: Pick<
    ElectronUtilityAdapterOptions,
    'diagnosticSession' | 'diagnosticLog' | 'diagnosticRootDir'
  > = {},
): NativeRuntimeAdapterFactory {
  return () => {
    const paths = resolveNativeRuntimePaths(runtime)
    return new ElectronUtilityAdapter({ runtime, ...paths, ...diagnostics })
  }
}

function maybeCreateNativeDiagnosticSession(
  runtime: NativeRuntimeKind,
  diagnosticRootDir = process.env.SYRNIKE_NATIVE_DIAGNOSTIC_ROOT_DIR,
) {
  if (!diagnosticRootDir) return undefined
  return createNativeDiagnosticSession({
    runtime,
    rootDir: diagnosticRootDir,
  })
}
