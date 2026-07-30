import fs from 'node:fs'
import path from 'node:path'

import { app, utilityProcess, type UtilityProcess } from 'electron'

import { DESKTOP_RELEASE_CHANNEL } from '../desktop-app-identity'
import {
  createNativeDiagnosticLog,
  createNativeDiagnosticSession,
  NATIVE_DIAGNOSTIC_MAX_FILE_BYTES,
  NATIVE_DIAGNOSTIC_MAX_ROLLED_FILES,
  redactDiagnosticText,
  rolledDiagnosticFilePath,
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
      // Remote video NT handles are process-local. Native duplicates them into
      // this PID before they cross the utility-process message boundary.
      SYRNIKE_ELECTRON_MAIN_PID: String(process.pid),
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
    if (diagnosticSession) {
      for (const filePath of [
        diagnosticSession.paths.utilityPath,
        diagnosticSession.paths.nativePath,
      ]) {
        try {
          rotateOversizedDiagnosticFileSync(filePath)
        } catch (error) {
          this.diagnosticLog?.log('diagnostic_prespawn_rotation_failed', {
            fileName: path.basename(filePath),
            error: error instanceof Error ? error.message : String(error),
          })
        }
      }
    }
    const child = fork(this.options.utilityEntryPath, [], {
      serviceName: `syrnike-${this.options.runtime}-runtime`,
      // stdout remains ignored, while stderr is drained into a bounded tail so
      // a native crash cannot fill a pipe or erase its last useful evidence.
      stdio: ['ignore', 'ignore', 'pipe'],
      env,
    })
    this.child = child
    const stderr = new BoundedByteTail()
    const stderrStream = child.stderr as
      | (NodeJS.ReadableStream & { readableEnded?: boolean })
      | null
    stderrStream?.on('data', (chunk) => {
      stderr.append(chunk)
    })
    this.diagnosticLog?.log('transport_started', {
      adapterPid: child.pid,
    })
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
      let finalized = false
      let drainTimer: ReturnType<typeof setTimeout> | null = null
      const finalize = () => {
        if (finalized) return
        finalized = true
        if (drainTimer) clearTimeout(drainTimer)
        stderrStream?.removeListener('end', finalize)
        const stderrSnapshot = stderr.snapshot()
        const exitWithDiagnostics = {
          ...exit,
          stderrBytesSeen: stderrSnapshot.bytesSeen,
          stderrBytesCaptured: stderrSnapshot.value.byteLength,
          stderrTruncated: stderrSnapshot.truncated,
        }
        this.diagnosticLog?.log('transport_exit', {
          adapterPid: child.pid,
          code: exitWithDiagnostics.code,
          signal: exitWithDiagnostics.signal,
          error: exitWithDiagnostics.error?.message,
          terminate,
          stderrBytesSeen: exitWithDiagnostics.stderrBytesSeen,
          stderrBytesCaptured: exitWithDiagnostics.stderrBytesCaptured,
          stderrTruncated: exitWithDiagnostics.stderrTruncated,
          stderrTailChunks: diagnosticTextChunks(stderrSnapshot.value),
        })
        this.releaseDiagnosticLog()
        callbacks.onExit(exitWithDiagnostics)
      }
      if (!stderrStream || stderrStream.readableEnded) {
        finalize()
        return
      }
      stderrStream.once('end', finalize)
      drainTimer = setTimeout(finalize, STDERR_DRAIN_GRACE_MS)
      drainTimer.unref?.()
    }
    child.on('message', (message) => {
      if (!isHighFrequencyMediaTransportMessage(message)) {
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
    if (!isFrameReleaseCommand(message.command)) {
      this.diagnosticLog?.log('transport_post', message)
    }
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
    // The exit/error path owns stderr draining and releases the log only after
    // the bounded tail has been recorded.
  }

  private releaseDiagnosticLog() {
    if (this.ownsDiagnosticLog) void this.diagnosticLog?.close()
    this.diagnosticLog = null
    this.ownsDiagnosticLog = false
  }
}

const MAX_STDERR_TAIL_BYTES = 16 * 1024
const MAX_DIAGNOSTIC_TEXT_CHUNK_BYTES = 4 * 1024
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

function diagnosticTextChunks(value: Buffer) {
  const text = redactDiagnosticText(
    value.toString('utf8'),
    Number.MAX_SAFE_INTEGER,
  )
  const chunks: string[] = []
  for (
    let offset = 0;
    offset < text.length;
    offset += MAX_DIAGNOSTIC_TEXT_CHUNK_BYTES
  ) {
    chunks.push(text.slice(offset, offset + MAX_DIAGNOSTIC_TEXT_CHUNK_BYTES))
  }
  return chunks
}

function rotateOversizedDiagnosticFileSync(filePath: string) {
  let size = 0
  try {
    size = fs.statSync(filePath).size
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
    throw error
  }
  if (size < NATIVE_DIAGNOSTIC_MAX_FILE_BYTES) return
  const last = rolledDiagnosticFilePath(
    filePath,
    NATIVE_DIAGNOSTIC_MAX_ROLLED_FILES,
  )
  try {
    fs.unlinkSync(last)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  for (
    let index = NATIVE_DIAGNOSTIC_MAX_ROLLED_FILES - 1;
    index >= 1;
    index -= 1
  ) {
    renameSyncIfPresent(
      rolledDiagnosticFilePath(filePath, index),
      rolledDiagnosticFilePath(filePath, index + 1),
    )
  }
  renameSyncIfPresent(filePath, rolledDiagnosticFilePath(filePath, 1))
}

function renameSyncIfPresent(source: string, destination: string) {
  try {
    fs.renameSync(source, destination)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
}

function isHighFrequencyMediaTransportMessage(message: unknown) {
  if (!message || typeof message !== 'object') return false
  const envelope = message as {
    type?: unknown
    event?: unknown
    ok?: unknown
  }
  if (envelope.type === 'reply' && envelope.ok === true) return true
  if (
    envelope.type !== 'event' ||
    !envelope.event ||
    typeof envelope.event !== 'object'
  ) {
    return false
  }
  const type = (envelope.event as { type?: unknown }).type
  return type === 'microphoneMetrics' ||
    type === 'remoteVideoFrame' ||
    type === 'localScreenPreviewFrame' ||
    type === 'localCameraPreviewFrame'
}

function isFrameReleaseCommand(command: NativeRuntimeRequest['command']) {
  return command.type === 'releaseRemoteVideoFrame' ||
    command.type === 'releaseLocalScreenPreviewFrame' ||
    command.type === 'releaseLocalCameraPreviewFrame'
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
  const utilityFilename = `${runtime}-host.cjs`
  const nativeFilename = `syrnike_${runtime}.node`
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
