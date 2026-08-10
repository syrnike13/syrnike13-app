import {
  appendFile,
  mkdir,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises'
import path from 'node:path'
import crypto from 'node:crypto'
import { performance } from 'node:perf_hooks'
import { Deferred, Effect, Fiber, Queue } from 'effect'

import type { DiagnosticEnvelope } from '@syrnike13/platform'
import type { NativeDiagnosticIncidentSeverity } from '@syrnike13/platform'

import { redactSensitiveText, type NativeRuntimeKind } from './contract'

export type NativeDiagnosticRole = 'electron-main' | 'utility' | 'native'

export type NativeDiagnosticPaths = {
  electronMainPath: string
  utilityPath: string
  nativePath: string
}

export type NativeDiagnosticSession = {
  runtime: NativeRuntimeKind
  runId: string
  directory: string
  latestPath: string
  paths: NativeDiagnosticPaths
}

export type DiagnosticLogRecord = {
  scope:
    | 'native-runtime-supervisor'
    | 'native-media-controller'
    | 'native-video'
    | 'desktop-voice'
  event: string
  runtime?: string
  kind?: string
  lane?: string
  operation?: string
  actionId?: string
  nativeEventType?: string
  nativeSequence?: number
  stage?: string
  commandStage?: string
  outcome?: string
  sessionId?: string
  requestId?: string
  hostEpoch?: number
  generation?: number
  candidateGeneration?: number
  fenceGeneration?: number
  revision?: number
  muted?: boolean
  fatal?: boolean
  incidentSeverity?: NativeDiagnosticIncidentSeverity
  pendingCount?: number
  queueDepth?: number
  queueWaitMs?: number
  timeoutMs?: number
  adapterPid?: number
  bypassedQueue?: boolean
  restartCount?: number
  recoveryAttempt?: number
  delayMs?: number
  durationMs?: number
  status?: string
  reason?: string
  message?: string
  errorCode?: string
  hresult?: number
  windowVisible?: boolean
  windowMinimized?: boolean
  metrics?: Record<string, number>
}

export type DiagnosticLogSink = (record: DiagnosticLogRecord) => void

export type NativeDiagnosticPrimitive =
  | null
  | boolean
  | number
  | string
  | NativeDiagnosticPrimitive[]
  | { [key: string]: NativeDiagnosticPrimitive }

type JsonValue = NativeDiagnosticPrimitive

type JsonRecord = Record<string, JsonValue>

type CreateNativeDiagnosticSessionOptions = {
  runtime: NativeRuntimeKind
  rootDir: string
  now?: () => number
  randomUUID?: () => string
}

type CreateNativeDiagnosticLogOptions = {
  runtime: NativeRuntimeKind
  role: NativeDiagnosticRole
  runId: string
  directory: string
  filePath: string
  latestPath?: string
  paths?: NativeDiagnosticPaths
  now?: () => number
  monotonicNow?: () => number
  pid?: number
  mkdirImpl?: typeof mkdir
  appendFileImpl?: typeof appendFile
  renameImpl?: typeof rename
  rmImpl?: typeof rm
  statImpl?: typeof stat
  writeFileImpl?: typeof writeFile
  maxFileBytes?: number
  maxRolledFiles?: number
  maxPendingWrites?: number
}

export interface NativeDiagnosticLog {
  readonly runtime: NativeRuntimeKind
  readonly role: NativeDiagnosticRole
  readonly runId: string
  readonly directory: string
  readonly filePath: string
  readonly latestPath?: string
  log(event: string, data?: unknown): void
  flushEffect(): Effect.Effect<void>
  flush(): Promise<void>
  closeEffect(): Effect.Effect<void>
  close(): Promise<void>
}

const ROLE_FILENAMES: Record<NativeDiagnosticRole, string> = {
  'electron-main': 'electron-main.jsonl',
  utility: 'utility.jsonl',
  native: 'native.jsonl',
}

const DIAGNOSTIC_SCHEMA = 'syrnike.diagnostic' as const
const DIAGNOSTIC_SCHEMA_VERSION = 1 as const

const OMITTED = '[omitted]'
const MAX_DEPTH = 6
const MAX_ARRAY_ITEMS = 32
const MAX_OBJECT_KEYS = 64
const DIAGNOSTIC_RETENTION_MS = 7 * 24 * 60 * 60 * 1_000
export const NATIVE_DIAGNOSTIC_MAX_FILE_BYTES = 5 * 1024 * 1024
export const NATIVE_DIAGNOSTIC_MAX_ROLLED_FILES = 2
export const NATIVE_DIAGNOSTIC_MAX_PENDING_WRITES = 1_024
const MAX_RETAINED_DIAGNOSTIC_SESSIONS = 20
const MAX_RETAINED_DIAGNOSTIC_BYTES = 200 * 1024 * 1024

const SENSITIVE_KEY =
  /token|authorization|url|identity|participant|user(?:id)?|device|label|source(?:id)?|window|hwnd|room(?:id|name|url)?|process(?:id|path)|path/i

export function createNativeDiagnosticSession({
  runtime,
  rootDir,
  now = Date.now,
  randomUUID = crypto.randomUUID,
}: CreateNativeDiagnosticSessionOptions): NativeDiagnosticSession {
  const runId = `${new Date(now()).toISOString().replace(/[:.]/g, '-')}-${randomUUID()}`
  const directory = path.join(rootDir, `native-${runtime}-${runId}`)
  const latestPath = path.join(rootDir, `native-${runtime}-latest.json`)
  return {
    runtime,
    runId,
    directory,
    latestPath,
    paths: {
      electronMainPath: path.join(directory, ROLE_FILENAMES['electron-main']),
      utilityPath: path.join(directory, ROLE_FILENAMES.utility),
      nativePath: path.join(directory, ROLE_FILENAMES.native),
    },
  }
}

export function pruneNativeDiagnosticSessions(
  rootDir: string,
  now = Date.now(),
): Promise<void> {
  return Effect.runPromise(
    pruneNativeDiagnosticSessionsEffect(rootDir, now),
  )
}

export const pruneNativeDiagnosticSessionsEffect = Effect.fn(
  'desktop.pruneNativeDiagnosticSessions',
)(function*(rootDir: string, now: number) {
  const entries = yield* Effect.tryPromise({
    try: () => readdir(rootDir, { withFileTypes: true }),
    catch: (cause) => cause,
  }).pipe(
    Effect.catch((error) =>
      isErrnoCode(error, 'ENOENT') ? Effect.succeed([]) : Effect.fail(error)
    ),
  )
  const cutoff = now - DIAGNOSTIC_RETENTION_MS
  const sessions = yield* Effect.all(
      entries
        .filter(
          (entry) =>
            entry.isDirectory() &&
            /^native-(?:media|hotkey|overlay)-/.test(entry.name),
        )
        .map((entry) =>
          Effect.gen(function*() {
            const directory = path.join(rootDir, entry.name)
            const [metadata, files] = yield* Effect.all(
              [
                Effect.tryPromise({
                  try: () => stat(directory),
                  catch: (cause) => cause,
                }),
                Effect.tryPromise({
                  try: () => readdir(directory, { withFileTypes: true }),
                  catch: (cause) => cause,
                }).pipe(Effect.catch(() => Effect.succeed([]))),
              ],
              { concurrency: 'unbounded' },
            )
            const sizes = yield* Effect.all(
              files
                .filter((file) => file.isFile())
                .map((file) =>
                  Effect.tryPromise({
                    try: () => stat(path.join(directory, file.name)),
                    catch: (cause) => cause,
                  }).pipe(
                    Effect.map((fileMetadata) => fileMetadata.size),
                    Effect.catch(() => Effect.succeed(0)),
                  )
                ),
              { concurrency: 'unbounded' },
            )
            const size = sizes.reduce((total, fileSize) => total + fileSize, 0)
            return { directory, modifiedAt: metadata.mtimeMs, size }
          })
        ),
      { concurrency: 'unbounded' },
    )
  sessions.sort((left, right) => right.modifiedAt - left.modifiedAt)

  let retainedBytes = 0
  const directoriesToRemove = sessions.flatMap((session, index) => {
    const expired = session.modifiedAt < cutoff
    const overCount = index >= MAX_RETAINED_DIAGNOSTIC_SESSIONS
    const overBytes =
      !expired &&
      !overCount &&
      retainedBytes + session.size > MAX_RETAINED_DIAGNOSTIC_BYTES
    if (expired || overCount || overBytes) {
      return [session.directory]
      }
    retainedBytes += session.size
    return []
  })
  yield* Effect.all(
    directoriesToRemove.map((directory) =>
      Effect.tryPromise({
        try: () => rm(directory, { recursive: true, force: true }),
        catch: (cause) => cause,
      })
    ),
    { concurrency: 'unbounded' },
  )
})

export function createNativeDiagnosticLog(
  options: CreateNativeDiagnosticLogOptions,
): NativeDiagnosticLog {
  const mkdirImpl = options.mkdirImpl ?? mkdir
  const appendFileImpl = options.appendFileImpl ?? appendFile
  const renameImpl = options.renameImpl ?? rename
  const rmImpl = options.rmImpl ?? rm
  const statImpl = options.statImpl ?? stat
  const writeFileImpl = options.writeFileImpl ?? writeFile
  const maxFileBytes =
    options.maxFileBytes ?? NATIVE_DIAGNOSTIC_MAX_FILE_BYTES
  const maxRolledFiles =
    options.maxRolledFiles ?? NATIVE_DIAGNOSTIC_MAX_ROLLED_FILES
  const maxPendingWrites = Math.max(
    1,
    options.maxPendingWrites ?? NATIVE_DIAGNOSTIC_MAX_PENDING_WRITES,
  )
  const now = options.now ?? Date.now
  const monotonicNow = options.monotonicNow ?? (() => performance.now())
  const pid = options.pid ?? process.pid
  let closed = false
  let sequence = 0
  let writtenBytes = 0
  let pendingWrites = 0
  let closeResult: Deferred.Deferred<void> | null = null
  let closePromise: Promise<void> | null = null

  const taskQueue = Effect.runSync(
    Queue.unbounded<Effect.Effect<void>>(),
  )
  Queue.offerUnsafe(
    taskQueue,
    Effect.gen(function*() {
      yield* Effect.tryPromise({
        try: () => mkdirImpl(options.directory, { recursive: true }),
        catch: (cause) => cause,
      })
      writtenBytes = yield* Effect.tryPromise({
        try: () => statImpl(options.filePath),
        catch: (cause) => cause,
      }).pipe(
        Effect.map((metadata) => metadata.size),
        Effect.catch((error) =>
          isErrnoCode(error, 'ENOENT') ? Effect.succeed(0) : Effect.fail(error),
        ),
      )
      if (!options.latestPath || !options.paths) return
      const latestPath = options.latestPath
      const paths = options.paths
      const latest = {
        runtime: options.runtime,
        runId: options.runId,
        directoryName: path.basename(options.directory),
        updatedAt: new Date(now()).toISOString(),
        files: {
          electronMain: path.basename(paths.electronMainPath),
          utility: path.basename(paths.utilityPath),
          native: path.basename(paths.nativePath),
        },
      }
      yield* Effect.tryPromise({
        try: () =>
          writeFileImpl(
            latestPath,
            `${JSON.stringify(latest)}\n`,
            'utf8',
          ),
        catch: (cause) => cause,
      })
    }).pipe(Effect.catch(() => Effect.void)),
  )

  const worker = Effect.runFork(
    Effect.forever(
      Queue.take(taskQueue).pipe(
        Effect.flatMap((task) => task),
      ),
    ),
  )

  const flushQueue = Effect.fn('desktop.flushNativeDiagnosticLog')(
    function*() {
      const completed = yield* Deferred.make<void>()
      const offered = Queue.offerUnsafe(
        taskQueue,
        Deferred.succeed(completed, undefined).pipe(Effect.asVoid),
      )
      if (offered) yield* Deferred.await(completed)
    },
  )
  const closeAtomic = flushQueue().pipe(
    Effect.andThen(Fiber.interrupt(worker)),
    Effect.andThen(Queue.shutdown(taskQueue)),
    Effect.asVoid,
  )
  const completeClose = (result: Deferred.Deferred<void>) =>
    Effect.exit(closeAtomic).pipe(
      Effect.flatMap((exit) => Deferred.done(result, exit)),
      Effect.asVoid,
    )
  const closeEffect = () =>
    Effect.suspend(() => {
      if (closeResult) return Deferred.await(closeResult)
      return Effect.gen(function*() {
        const result = yield* Deferred.make<void>()
        if (closeResult) return yield* Deferred.await(closeResult)
        closeResult = result
        closed = true
        yield* completeClose(result).pipe(Effect.forkDetach)
        return yield* Deferred.await(result)
      })
    })
  const flushEffect = () =>
    closeResult ? Deferred.await(closeResult) : flushQueue()

  return {
    runtime: options.runtime,
    role: options.role,
    runId: options.runId,
    directory: options.directory,
    filePath: options.filePath,
    latestPath: options.latestPath,
    log(event, data) {
      if (closed) return
      if (pendingWrites >= maxPendingWrites) return
      try {
        const epochMs = now()
        const entry: DiagnosticEnvelope = {
          schema: DIAGNOSTIC_SCHEMA,
          version: DIAGNOSTIC_SCHEMA_VERSION,
          record_type: 'event',
          timestamp_ms: epochMs,
          source: options.role,
          event: redactDiagnosticText(event).slice(0, 256),
          data: {
            runtime: options.runtime,
            run_id: options.runId,
            sequence: ++sequence,
            pid,
            monotonic_ms: monotonicNow(),
          },
        }
        const sanitized = sanitizeDiagnosticValue(data)
        if (sanitized !== undefined) {
          entry.data.payload = sanitized
        }
        const line = `${JSON.stringify(entry)}\n`
        const lineBytes = Buffer.byteLength(line)
        pendingWrites += 1
        const offered = Queue.offerUnsafe(
          taskQueue,
          Effect.gen(function*() {
            if (
              maxFileBytes > 0 &&
              writtenBytes > 0 &&
              writtenBytes + lineBytes > maxFileBytes
            ) {
              yield* rotateDiagnosticFile(
                options.filePath,
                maxRolledFiles,
                renameImpl,
                rmImpl,
              )
              writtenBytes = 0
            }
            yield* Effect.tryPromise({
              try: () => appendFileImpl(options.filePath, line, 'utf8'),
              catch: (cause) => cause,
            })
            writtenBytes += lineBytes
          }).pipe(
            Effect.catch(() => Effect.void),
            Effect.ensuring(
              Effect.sync(() => {
                pendingWrites -= 1
              }),
            ),
          ),
        )
        if (!offered) pendingWrites -= 1
      } catch {
        // Diagnostics must never change runtime behavior.
      }
    },
    flush() {
      return closePromise ?? Effect.runPromise(flushEffect())
    },
    flushEffect,
    close() {
      if (closePromise) return closePromise
      closePromise = Effect.runPromise(closeEffect())
      return closePromise
    },
    closeEffect,
  }
}

export function rolledDiagnosticFilePath(filePath: string, index: number) {
  const extension = path.extname(filePath)
  const stem = extension ? filePath.slice(0, -extension.length) : filePath
  return `${stem}.${index}${extension}`
}

const rotateDiagnosticFile = Effect.fn('desktop.rotateDiagnosticFile')(
  function*(
  filePath: string,
  maxRolledFiles: number,
  renameImpl: typeof rename,
  rmImpl: typeof rm,
  ) {
  if (maxRolledFiles <= 0) {
      yield* Effect.tryPromise({
        try: () => rmImpl(filePath, { force: true }),
        catch: (cause) => cause,
      })
    return
  }
    yield* Effect.tryPromise({
      try: () =>
        rmImpl(rolledDiagnosticFilePath(filePath, maxRolledFiles), {
          force: true,
        }),
      catch: (cause) => cause,
    })
  for (let index = maxRolledFiles - 1; index >= 1; index -= 1) {
      yield* renameIfPresent(
      rolledDiagnosticFilePath(filePath, index),
      rolledDiagnosticFilePath(filePath, index + 1),
      renameImpl,
    )
  }
    yield* renameIfPresent(
    filePath,
    rolledDiagnosticFilePath(filePath, 1),
    renameImpl,
  )
  },
)

const renameIfPresent = Effect.fn('desktop.renameDiagnosticFileIfPresent')(
  function*(source: string, destination: string, renameImpl: typeof rename) {
    yield* Effect.tryPromise({
      try: () => renameImpl(source, destination),
      catch: (cause) => cause,
    }).pipe(
      Effect.catch((error) =>
        isErrnoCode(error, 'ENOENT') ? Effect.void : Effect.fail(error),
      ),
    )
  },
)

export function sanitizeDiagnosticValue(value: unknown): JsonValue | undefined {
  return sanitizeValue(value, 0)
}

function sanitizeValue(value: unknown, depth: number): JsonValue | undefined {
  if (value == null) return null
  if (typeof value === 'boolean') return value
  if (typeof value === 'number') return Number.isFinite(value) ? value : OMITTED
  if (typeof value === 'string') return redactDiagnosticText(value)
  if (depth >= MAX_DEPTH) return OMITTED
  if (Array.isArray(value)) {
    return value
      .slice(0, MAX_ARRAY_ITEMS)
      .map((item) => sanitizeValue(item, depth + 1))
      .filter((item): item is JsonValue => item !== undefined)
  }
  if (isPlainObject(value)) {
    const entries = Object.entries(value).slice(0, MAX_OBJECT_KEYS)
    const next: JsonRecord = Object.create(null) as JsonRecord
    for (const [key, nested] of entries) {
      if (
        SENSITIVE_KEY.test(key) ||
        key === '__proto__' ||
        key === 'prototype' ||
        key === 'constructor'
      ) {
        continue
      }
      const sanitizedKey = redactDiagnosticText(key).slice(0, 128)
      const sanitizedValue = sanitizeValue(nested, depth + 1)
      if (sanitizedValue !== undefined) {
        next[sanitizedKey] = sanitizedValue
      }
    }
    return next
  }
  return OMITTED
}

export function redactDiagnosticText(
  value: string,
  maximumLength = 4_096,
) {
  return redactSensitiveText(value, Number.MAX_SAFE_INTEGER)
    .replace(
      /\b(identity|participant(?:Identity)?|user(?:Id)?|room(?:Id|Name|Url)?|device(?:Id|Name)?|source(?:Id)?|window(?:Title)?|processPath)\s*[:=]\s*(?:["']?)[^\s,;"'}\]]+/gi,
      '$1=[redacted]',
    )
    .replace(/\b[A-Za-z]:[\\/][^\r\n"',;}\]]+/g, '[redacted-path]')
    .replace(/\\\\[^\\\s]+\\[^\r\n"',;}\]]+/g, '[redacted-path]')
    .slice(0, maximumLength)
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object') return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function isErrnoCode(error: unknown, code: string) {
  return error instanceof Error && 'code' in error && error.code === code
}
