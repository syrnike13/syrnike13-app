import { appendFile, mkdir, readdir, rm, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import crypto from 'node:crypto'
import { performance } from 'node:perf_hooks'

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
  scope: 'native-runtime-supervisor' | 'native-media-controller'
  event: string
  runtime?: string
  kind?: string
  lane?: string
  operation?: string
  nativeEventType?: string
  nativeSequence?: number
  stage?: string
  sessionId?: string
  requestId?: string
  generation?: number
  candidateGeneration?: number
  fenceGeneration?: number
  revision?: number
  muted?: boolean
  pendingCount?: number
  queueDepth?: number
  queueWaitMs?: number
  timeoutMs?: number
  adapterPid?: number
  bypassedQueue?: boolean
  restartCount?: number
  delayMs?: number
  durationMs?: number
  status?: string
  reason?: string
  message?: string
  errorCode?: string
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

type NativeDiagnosticEvent = {
  ts: string
  epochMs: number
  monotonicMs: number
  sequence: number
  pid: number
  runtime: NativeRuntimeKind
  runId: string
  role: NativeDiagnosticRole
  event: string
  data?: JsonValue
}

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
  writeFileImpl?: typeof writeFile
}

export interface NativeDiagnosticLog {
  readonly runtime: NativeRuntimeKind
  readonly role: NativeDiagnosticRole
  readonly runId: string
  readonly directory: string
  readonly filePath: string
  readonly latestPath?: string
  log(event: string, data?: unknown): void
  flush(): Promise<void>
  close(): Promise<void>
}

const ROLE_FILENAMES: Record<NativeDiagnosticRole, string> = {
  'electron-main': 'electron-main.jsonl',
  utility: 'utility.jsonl',
  native: 'native.jsonl',
}

const OMITTED = '[omitted]'
const MAX_DEPTH = 6
const MAX_ARRAY_ITEMS = 32
const MAX_OBJECT_KEYS = 64
const DIAGNOSTIC_RETENTION_MS = 7 * 24 * 60 * 60 * 1_000

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

export async function pruneNativeDiagnosticSessions(
  rootDir: string,
  now = Date.now(),
): Promise<void> {
  const entries = await readdir(rootDir, { withFileTypes: true }).catch(
    (error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return []
      throw error
    },
  )
  const cutoff = now - DIAGNOSTIC_RETENTION_MS
  await Promise.all(
    entries
      .filter(
        (entry) =>
          entry.isDirectory() && /^native-(?:media|hooks)-/.test(entry.name),
      )
      .map(async (entry) => {
        const directory = path.join(rootDir, entry.name)
        const metadata = await stat(directory)
        if (metadata.mtimeMs >= cutoff) return
        await rm(directory, { recursive: true, force: true })
      }),
  )
}

export function createNativeDiagnosticLog(
  options: CreateNativeDiagnosticLogOptions,
): NativeDiagnosticLog {
  const mkdirImpl = options.mkdirImpl ?? mkdir
  const appendFileImpl = options.appendFileImpl ?? appendFile
  const writeFileImpl = options.writeFileImpl ?? writeFile
  const now = options.now ?? Date.now
  const monotonicNow = options.monotonicNow ?? (() => performance.now())
  const pid = options.pid ?? process.pid
  let closed = false
  let sequence = 0

  let queue = mkdirImpl(options.directory, { recursive: true }).then(async () => {
    if (!options.latestPath || !options.paths) return
    const latest = {
      runtime: options.runtime,
      runId: options.runId,
      directoryName: path.basename(options.directory),
      updatedAt: new Date(now()).toISOString(),
      files: {
        electronMain: path.basename(options.paths.electronMainPath),
        utility: path.basename(options.paths.utilityPath),
        native: path.basename(options.paths.nativePath),
      },
    }
    await writeFileImpl(
      options.latestPath,
      `${JSON.stringify(latest)}\n`,
      'utf8',
    )
  })
  void queue.catch(() => undefined)

  const enqueue = (task: () => Promise<void>) => {
    queue = queue.then(task, task)
    void queue.catch(() => undefined)
    return queue
  }

  return {
    runtime: options.runtime,
    role: options.role,
    runId: options.runId,
    directory: options.directory,
    filePath: options.filePath,
    latestPath: options.latestPath,
    log(event, data) {
      if (closed) return
      try {
        const epochMs = now()
        const entry: NativeDiagnosticEvent = {
          ts: new Date(epochMs).toISOString(),
          epochMs,
          monotonicMs: monotonicNow(),
          sequence: ++sequence,
          pid,
          runtime: options.runtime,
          runId: options.runId,
          role: options.role,
          event: redactDiagnosticText(event).slice(0, 256),
        }
        const sanitized = sanitizeDiagnosticValue(data)
        if (sanitized !== undefined) {
          entry.data = sanitized
        }
        void enqueue(() =>
          appendFileImpl(options.filePath, `${JSON.stringify(entry)}\n`, 'utf8'),
        ).catch(() => undefined)
      } catch {
        // Diagnostics must never change runtime behavior.
      }
    },
    async flush() {
      await queue.catch(() => undefined)
    },
    async close() {
      if (closed) {
        await queue.catch(() => undefined)
        return
      }
      closed = true
      await queue.catch(() => undefined)
    },
  }
}

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

function redactDiagnosticText(value: string) {
  return redactSensitiveText(value)
    .replace(
      /\b(identity|participant(?:Identity)?|user(?:Id)?|room(?:Id|Name|Url)?|device(?:Id|Name)?|source(?:Id)?|window(?:Title)?|processPath)\s*[:=]\s*(?:["']?)[^\s,;"'}\]]+/gi,
      '$1=[redacted]',
    )
    .replace(/\b[A-Za-z]:[\\/][^\r\n"',;}\]]+/g, '[redacted-path]')
    .replace(/\\\\[^\\\s]+\\[^\r\n"',;}\]]+/g, '[redacted-path]')
    .slice(0, 4_096)
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object') return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}
