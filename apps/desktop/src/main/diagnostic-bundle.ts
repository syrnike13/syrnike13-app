import { open, readdir, stat } from 'node:fs/promises'
import path from 'node:path'
import { promisify } from 'node:util'
import { gzip } from 'node:zlib'

import { app } from 'electron'
import {
  DiagnosticEnvelopeSchema,
  DiagnosticEnvelopeSourceSchema,
  type DiagnosticEnvelope,
  type DiagnosticEnvelopeSource,
  type DiagnosticJsonValue,
} from '@syrnike13/platform'
import { Effect, Option, Schema, SchemaTransformation } from 'effect'

import { sanitizeDiagnosticValue } from './native-runtime/diagnostic-log'

const MAX_RENDERER_BYTES = 2 * 1024 * 1024
const MAX_NATIVE_BYTES = 30 * 1024 * 1024
const MAX_COMPRESSED_BUNDLE_BYTES = 10 * 1024 * 1024
const MAX_DECOMPRESSED_BUNDLE_BYTES = 33 * 1024 * 1024
const INVENTORY_RESERVE_BYTES = 64 * 1024
const MAX_NATIVE_SESSIONS = 3
const DIAGNOSTIC_SCHEMA = 'syrnike.diagnostic' as const
const DIAGNOSTIC_SCHEMA_VERSION = 1 as const
const gzipAsync = promisify(gzip)
const UnknownJsonSchema = Schema.String.pipe(
  Schema.decodeTo(Schema.Unknown, SchemaTransformation.fromJsonString()),
)
const UnknownRecordSchema = Schema.Record(Schema.String, Schema.Unknown)
const DiagnosticDataSchema = Schema.Record(Schema.String, Schema.Json)

type NativeDiagnosticFile = {
  value: string
  source: DiagnosticEnvelopeSource
  bytes: number
  truncated: boolean
}

type NativeDiagnosticReadResult = {
  files: NativeDiagnosticFile[]
  sessionsFound: number
  sessionsSelected: number
  filesFound: number
  filesSelected: number
}

export const createDesktopDiagnosticBundleEffect = Effect.fn(
  'desktop.createDiagnosticBundle',
)(function*(rendererJsonl: string) {
  if (typeof rendererJsonl !== 'string') {
    return yield* Effect.fail(
      new Error('Diagnostic records must be a string'),
    )
  }
  if (Buffer.byteLength(rendererJsonl) > MAX_RENDERER_BYTES) {
    return yield* Effect.fail(
      new Error('Renderer diagnostic records are too large'),
    )
  }

  const rendererRecords = yield* Effect.try({
    try: () => normalizeJsonl(rendererJsonl, 'renderer', true),
    catch: (cause) => cause,
  })
  const native = yield* readRecentNativeDiagnosticsEffect()
  const nativeRecordGroups = native.files.map((file) =>
    normalizeJsonl(file.value, file.source, false),
  )
  const rendererBytes = serializedRecordsBytes(rendererRecords)
  const nativeBudget = Math.max(
    0,
    MAX_DECOMPRESSED_BUNDLE_BYTES - rendererBytes - INVENTORY_RESERVE_BYTES,
  )
  let selectionBudget = nativeBudget
  for (let attempt = 0; ; attempt += 1) {
    const bundle = yield* buildNormalizedBundleEffect(
      rendererRecords,
      native,
      nativeRecordGroups,
      selectionBudget,
    )
    if (bundle.byteLength <= MAX_COMPRESSED_BUNDLE_BYTES) {
      return new Uint8Array(bundle)
    }
    if (selectionBudget === 0) {
      return yield* Effect.fail(
        new Error('Compressed diagnostic bundle is too large'),
      )
    }
    selectionBudget =
      attempt >= 7
        ? 0
        : Math.max(
            0,
            Math.min(
              selectionBudget - 1,
              Math.floor(
                selectionBudget *
                  (MAX_COMPRESSED_BUNDLE_BYTES / bundle.byteLength) *
                  0.9,
              ),
            ),
          )
  }
})

export function createDesktopDiagnosticBundle(rendererJsonl: string) {
  return Effect.runPromise(createDesktopDiagnosticBundleEffect(rendererJsonl))
}

const buildNormalizedBundleEffect = Effect.fn(
  'desktop.buildNormalizedDiagnosticBundle',
)(function*(
  rendererRecords: DiagnosticEnvelope[],
  native: NativeDiagnosticReadResult,
  nativeRecordGroups: DiagnosticEnvelope[][],
  nativeBudget: number,
) {
  const normalizedGroupBytes = nativeRecordGroups.map(serializedRecordsBytes)
  const normalizedBudgets = allocateFairReadBudgets(
    normalizedGroupBytes,
    nativeBudget,
  )
  const selectedGroups = nativeRecordGroups.map((records, index) =>
    selectRecordTail(records, normalizedBudgets[index] ?? 0),
  )
  const nativeRecords = selectedGroups.flat()
  const recordsBySource = nativeRecords.reduce<Record<string, number>>(
    (counts, record) => {
      counts[record.source] = (counts[record.source] ?? 0) + 1
      return counts
    },
    {},
  )
  const inventory = envelope(
    'event',
    Date.now(),
    'electron-main',
    'diagnostic.bundle_inventory',
    {
      native_limit_bytes: MAX_NATIVE_BYTES,
      compressed_limit_bytes: MAX_COMPRESSED_BUNDLE_BYTES,
      decompressed_limit_bytes: MAX_DECOMPRESSED_BUNDLE_BYTES,
      native_selection_budget_bytes: nativeBudget,
      native_sessions_found: native.sessionsFound,
      native_sessions_selected: native.sessionsSelected,
      native_files_found: native.filesFound,
      native_files_selected: native.filesSelected,
      native_files_included: selectedGroups.filter((records) => records.length > 0).length,
      native_files_truncated: native.files.filter(
        (file, index) =>
          file.truncated || selectedGroups[index]!.length < nativeRecordGroups[index]!.length,
      ).length,
      native_source_bytes_read: native.files.reduce((sum, file) => sum + file.bytes, 0),
      native_bytes_included: serializedRecordsBytes(nativeRecords),
      native_records_included: nativeRecords.length,
      native_records_by_source: recordsBySource,
    },
  )
  const [firstRendererRecord, ...rendererEvents] = rendererRecords
  const events = [...rendererEvents, ...nativeRecords, inventory].sort(
    (left, right) => left.timestamp_ms - right.timestamp_ms,
  )
  const jsonl = [firstRendererRecord, ...events]
    .map((record) => JSON.stringify(record))
    .join('\n')
  if (Buffer.byteLength(jsonl) > MAX_DECOMPRESSED_BUNDLE_BYTES) {
    return yield* Effect.fail(
      new Error('Normalized diagnostic bundle is too large'),
    )
  }
  return yield* Effect.tryPromise({
    try: () => gzipAsync(jsonl, { level: 6 }),
    catch: (cause) => cause,
  })
})

function serializedRecordsBytes(records: DiagnosticEnvelope[]) {
  return records.reduce(
    (total, record) => total + Buffer.byteLength(JSON.stringify(record)) + 1,
    0,
  )
}

function selectRecordTail(records: DiagnosticEnvelope[], maximumBytes: number) {
  const selected: DiagnosticEnvelope[] = []
  let used = 0
  for (let index = records.length - 1; index >= 0; index -= 1) {
    const record = records[index]!
    const bytes = Buffer.byteLength(JSON.stringify(record)) + 1
    if (bytes > maximumBytes - used) break
    selected.unshift(record)
    used += bytes
  }
  return selected
}

function normalizeJsonl(
  value: string,
  fallbackSource: DiagnosticEnvelopeSource,
  strict: boolean,
) {
  const records: DiagnosticEnvelope[] = []
  for (const line of value.split(/\r?\n/)) {
    if (!line.trim()) continue
    try {
      const json = Schema.decodeUnknownOption(UnknownJsonSchema)(line)
      if (Option.isNone(json)) throw new Error('Invalid diagnostic JSON')
      const normalized = normalizeRecord(json.value, fallbackSource)
      if (!normalized) throw new Error('Unsupported diagnostic record')
      records.push(normalized)
    } catch (error) {
      if (strict) throw new Error('Renderer diagnostics contain invalid JSONL', { cause: error })
    }
  }
  if (strict && records.length === 0) {
    throw new Error('Renderer diagnostics are empty')
  }
  return records
}

function normalizeRecord(
  value: unknown,
  fallbackSource: DiagnosticEnvelopeSource,
): DiagnosticEnvelope | null {
  const decodedEnvelope =
    Schema.decodeUnknownOption(DiagnosticEnvelopeSchema)(value)
  if (Option.isSome(decodedEnvelope)) {
    return {
      ...decodedEnvelope.value,
      data: sanitizeBundleData(decodedEnvelope.value.data),
    }
  }

  const record = Schema.decodeUnknownOption(UnknownRecordSchema)(value)
  if (Option.isNone(record)) return null
  const legacy = record.value

  if (legacy.type === 'manifest') {
    return envelope(
      'manifest',
      timestamp(legacy.generatedAt),
      fallbackSource,
      'report_manifest',
      {
        source: diagnosticString(legacy.source, 'desktop'),
        release_channel: diagnosticString(
          legacy.releaseChannel,
          'development',
        ),
        app_version: diagnosticString(legacy.appVersion, 'unknown'),
        platform: diagnosticString(legacy.platform, 'unknown'),
        area: diagnosticString(legacy.area, 'client'),
        severity: diagnosticString(legacy.severity, 'error'),
        trigger_code: diagnosticString(legacy.triggerCode, 'unknown_error'),
      },
    )
  }

  if (typeof legacy.event !== 'string') return null
  const source = isEnvelopeSource(legacy.role) ? legacy.role : fallbackSource
  const event =
    typeof legacy.area === 'string'
      ? `${legacy.area}.${legacy.event}`
      : legacy.event
  const timestampMs =
    numericTimestamp(legacy.timestamp) ??
    numericTimestamp(legacy.epochMs) ??
    numericTimestamp(legacy.wallTimeUnixMs) ??
    0
  const data = Schema.decodeUnknownOption(DiagnosticDataSchema)(
    Object.fromEntries(
      Object.entries(legacy).filter(
        ([key]) =>
          ![
            'event',
            'area',
            'timestamp',
            'epochMs',
            'wallTimeUnixMs',
            'role',
          ].includes(key),
      ),
    ),
  )
  if (Option.isNone(data)) return null
  return envelope(
    'event',
    timestampMs,
    source,
    event,
    sanitizeBundleData(data.value),
  )
}

function sanitizeBundleData(value: unknown): Record<string, DiagnosticJsonValue> {
  const sanitized = sanitizeDiagnosticValue(value)
  const decoded = Schema.decodeUnknownOption(DiagnosticDataSchema)(sanitized)
  return Option.isSome(decoded)
    ? decoded.value
    : { omitted: 'invalid_diagnostic_data' }
}

function envelope(
  recordType: DiagnosticEnvelope['record_type'],
  timestampMs: number,
  source: DiagnosticEnvelopeSource,
  event: string,
  data: Record<string, DiagnosticJsonValue>,
): DiagnosticEnvelope {
  return {
    schema: DIAGNOSTIC_SCHEMA,
    version: DIAGNOSTIC_SCHEMA_VERSION,
    record_type: recordType,
    timestamp_ms: timestampMs,
    source,
    event,
    data,
  }
}

function timestamp(value: unknown) {
  if (typeof value !== 'string') return 0
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? parsed : 0
}

function numericTimestamp(value: unknown) {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function diagnosticString(value: unknown, fallback: string) {
  return typeof value === 'string' && value ? value : fallback
}

function isEnvelopeSource(value: unknown): value is DiagnosticEnvelopeSource {
  return Option.isSome(
    Schema.decodeUnknownOption(DiagnosticEnvelopeSourceSchema)(value),
  )
}

const readRecentNativeDiagnosticsEffect = Effect.fn(
  'desktop.readRecentNativeDiagnostics',
)(function*() {
  const root = path.join(
    app.getPath('userData'),
    'logs',
    'native-media-diagnostics',
  )
  const entries = yield* readDirectoryOrEmpty(root)
  const discoveredSessions = yield* Effect.all(
    entries
      .filter((entry) => entry.isDirectory() && entry.name.startsWith('native-'))
      .map((entry) =>
        Effect.gen(function*() {
          const directory = path.join(root, entry.name)
          const files = yield* readDirectoryOrEmpty(directory)
          const diagnostics = (
            yield* Effect.all(
              files
                .filter((file) => file.isFile() && file.name.endsWith('.jsonl'))
                .map((file) => {
                  const filePath = path.join(directory, file.name)
                  return Effect.tryPromise({
                    try: () => stat(filePath),
                    catch: (cause) => cause,
                  }).pipe(
                    Effect.map((metadata) => ({
                      filePath,
                      fileName: file.name,
                      size: metadata.size,
                      modifiedAt: metadata.mtimeMs,
                    })),
                    Effect.catch(() => Effect.succeed(null)),
                  )
                }),
              { concurrency: 'unbounded' },
            )
          ).filter((file): file is NonNullable<typeof file> => file !== null)
          const directoryModifiedAt = yield* Effect.tryPromise({
            try: () => stat(directory),
            catch: (cause) => cause,
          }).pipe(
            Effect.map((metadata) => metadata.mtimeMs),
            Effect.catch(() => Effect.succeed(0)),
          )
          return {
            files: diagnostics,
            modifiedAt: diagnostics.reduce(
              (latest, file) => Math.max(latest, file.modifiedAt),
              directoryModifiedAt,
            ),
          }
        }),
      ),
    { concurrency: 'unbounded' },
  )
  discoveredSessions.sort((a, b) => b.modifiedAt - a.modifiedAt)
  const sessions = discoveredSessions.slice(0, MAX_NATIVE_SESSIONS)
  const candidates = sessions.flatMap((session) => session.files)
  const budgets = allocateFairReadBudgets(
    candidates.map((candidate) => candidate.size),
    MAX_NATIVE_BYTES,
  )
  const included = (
    yield* Effect.all(
      candidates.map((candidate, index) => {
        const budget = budgets[index] ?? 0
        if (budget <= 0) return Effect.succeed(null)
        return readBoundedTail(candidate.filePath, budget).pipe(
          Effect.map(({ value, truncated }) => {
            let bounded = value
            if (truncated) {
              const firstCompleteLine = bounded.indexOf(0x0a)
              bounded =
                firstCompleteLine === -1
                  ? Buffer.alloc(0)
                  : bounded.subarray(firstCompleteLine + 1)
            }
            if (bounded.length === 0) return null
            return {
              value: bounded.toString('utf8'),
              source: diagnosticSourceForFile(candidate.fileName),
              bytes: bounded.length,
              truncated,
            } satisfies NativeDiagnosticFile
          }),
        )
      }),
      { concurrency: 'unbounded' },
    )
  ).filter((file): file is NativeDiagnosticFile => file !== null)
  return {
    files: included,
    sessionsFound: discoveredSessions.length,
    sessionsSelected: sessions.length,
    filesFound: discoveredSessions.reduce(
      (count, session) => count + session.files.length,
      0,
    ),
    filesSelected: candidates.length,
  }
})

function readDirectoryOrEmpty(directory: string) {
  return Effect.tryPromise({
    try: () => readdir(directory, { withFileTypes: true }),
    catch: (cause) => cause,
  }).pipe(Effect.catch(() => Effect.succeed([])))
}

function allocateFairReadBudgets(sizes: number[], maximumBytes: number) {
  const budgets = sizes.map(() => 0)
  let remaining = maximumBytes
  let pending = sizes
    .map((size, index) => ({ index, size: Math.max(0, size) }))
    .filter(({ size }) => size > 0)

  while (pending.length > 0 && remaining > 0) {
    const share = Math.floor(remaining / pending.length)
    if (share <= 0) {
      for (const candidate of pending.slice(0, remaining)) {
        budgets[candidate.index] = 1
      }
      break
    }
    const small = pending.filter(({ size }) => size <= share)
    if (small.length > 0) {
      const completed = new Set(small.map(({ index }) => index))
      for (const candidate of small) {
        budgets[candidate.index] = candidate.size
        remaining -= candidate.size
      }
      pending = pending.filter(({ index }) => !completed.has(index))
      continue
    }
    for (const candidate of pending) budgets[candidate.index] = share
    remaining -= share * pending.length
    for (const candidate of pending.slice(0, remaining)) {
      budgets[candidate.index] += 1
    }
    break
  }
  return budgets
}

function diagnosticSourceForFile(fileName: string): DiagnosticEnvelopeSource {
  if (/^electron-main(?:\.\d+)?\.jsonl$/.test(fileName)) {
    return 'electron-main'
  }
  if (/^utility(?:\.\d+)?\.jsonl$/.test(fileName)) return 'utility'
  return 'native'
}

function readBoundedTail(filePath: string, maximumBytes: number) {
  return Effect.acquireUseRelease(
    Effect.tryPromise({
      try: () => open(filePath, 'r'),
      catch: (cause) => cause,
    }),
    (handle) =>
      Effect.gen(function*() {
        const { size } = yield* Effect.tryPromise({
          try: () => handle.stat(),
          catch: (cause) => cause,
        })
        const length = Math.min(size, maximumBytes)
        if (length <= 0) {
          return { value: Buffer.alloc(0), truncated: size > 0 }
        }

        const value = Buffer.allocUnsafe(length)
        const position = Math.max(0, size - length)
        let offset = 0
        while (offset < length) {
          const { bytesRead } = yield* Effect.tryPromise({
            try: () =>
              handle.read(
                value,
                offset,
                length - offset,
                position + offset,
              ),
            catch: (cause) => cause,
          })
          if (bytesRead === 0) break
          offset += bytesRead
        }
        return {
          value: value.subarray(0, offset),
          truncated: position > 0,
        }
      }),
    (handle) =>
      Effect.tryPromise({
        try: () => handle.close(),
        catch: (cause) => cause,
      }).pipe(Effect.catch(() => Effect.void)),
  ).pipe(
    Effect.catch(() =>
      Effect.succeed({ value: Buffer.alloc(0), truncated: false })
    ),
  )
}
