import { open, readdir, stat } from 'node:fs/promises'
import path from 'node:path'
import { promisify } from 'node:util'
import { gzip } from 'node:zlib'

import { app } from 'electron'
import type {
  DiagnosticEnvelope,
  DiagnosticEnvelopeSource,
  DiagnosticJsonValue,
} from '@syrnike13/platform'

const MAX_RENDERER_BYTES = 2 * 1024 * 1024
const MAX_NATIVE_BYTES = 30 * 1024 * 1024
const MAX_COMPRESSED_BUNDLE_BYTES = 10 * 1024 * 1024
const MAX_DECOMPRESSED_BUNDLE_BYTES = 33 * 1024 * 1024
const INVENTORY_RESERVE_BYTES = 64 * 1024
const MAX_NATIVE_SESSIONS = 3
const DIAGNOSTIC_SCHEMA = 'syrnike.diagnostic' as const
const DIAGNOSTIC_SCHEMA_VERSION = 1 as const
const gzipAsync = promisify(gzip)

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

export async function createDesktopDiagnosticBundle(rendererJsonl: string) {
  if (typeof rendererJsonl !== 'string') {
    throw new Error('Diagnostic records must be a string')
  }
  if (Buffer.byteLength(rendererJsonl) > MAX_RENDERER_BYTES) {
    throw new Error('Renderer diagnostic records are too large')
  }

  const rendererRecords = normalizeJsonl(rendererJsonl, 'renderer', true)
  const native = await readRecentNativeDiagnostics()
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
    const bundle = await buildNormalizedBundle(
      rendererRecords,
      native,
      nativeRecordGroups,
      selectionBudget,
    )
    if (bundle.byteLength <= MAX_COMPRESSED_BUNDLE_BYTES) {
      return new Uint8Array(bundle)
    }
    if (selectionBudget === 0) {
      throw new Error('Compressed diagnostic bundle is too large')
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
}

async function buildNormalizedBundle(
  rendererRecords: DiagnosticEnvelope[],
  native: NativeDiagnosticReadResult,
  nativeRecordGroups: DiagnosticEnvelope[][],
  nativeBudget: number,
) {
  const normalizedGroupBytes = nativeRecordGroups.map(serializedRecordsBytes)
  const normalizedBudgets = allocateFairReadBudgets(normalizedGroupBytes, nativeBudget)
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
    throw new Error('Normalized diagnostic bundle is too large')
  }
  return gzipAsync(jsonl, { level: 6 })
}

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
      const normalized = normalizeRecord(JSON.parse(line), fallbackSource)
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
  if (!isRecord(value)) return null
  if (
    value.schema === DIAGNOSTIC_SCHEMA &&
    value.version === DIAGNOSTIC_SCHEMA_VERSION &&
    (value.record_type === 'manifest' || value.record_type === 'event') &&
    typeof value.timestamp_ms === 'number' &&
    isEnvelopeSource(value.source) &&
    typeof value.event === 'string' &&
    isRecord(value.data)
  ) {
    return {
      schema: DIAGNOSTIC_SCHEMA,
      version: DIAGNOSTIC_SCHEMA_VERSION,
      record_type: value.record_type,
      timestamp_ms: value.timestamp_ms,
      source: value.source,
      event: value.event,
      data: value.data as Record<string, DiagnosticJsonValue>,
    }
  }

  if (value.type === 'manifest') {
    return envelope(
      'manifest',
      timestamp(value.generatedAt),
      fallbackSource,
      'report_manifest',
      {
        source: diagnosticString(value.source, 'desktop'),
        release_channel: diagnosticString(value.releaseChannel, 'development'),
        app_version: diagnosticString(value.appVersion, 'unknown'),
        platform: diagnosticString(value.platform, 'unknown'),
        area: diagnosticString(value.area, 'client'),
        severity: diagnosticString(value.severity, 'error'),
        trigger_code: diagnosticString(value.triggerCode, 'unknown_error'),
      },
    )
  }

  if (typeof value.event !== 'string') return null
  const source = isEnvelopeSource(value.role) ? value.role : fallbackSource
  const event =
    typeof value.area === 'string' ? `${value.area}.${value.event}` : value.event
  const timestampMs =
    numericTimestamp(value.timestamp) ??
    numericTimestamp(value.epochMs) ??
    numericTimestamp(value.wallTimeUnixMs) ??
    0
  const data = Object.fromEntries(
    Object.entries(value).filter(
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
  ) as Record<string, DiagnosticJsonValue>
  return envelope('event', timestampMs, source, event, data)
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function isEnvelopeSource(value: unknown): value is DiagnosticEnvelopeSource {
  return (
    value === 'web' ||
    value === 'renderer' ||
    value === 'electron-main' ||
    value === 'utility' ||
    value === 'native'
  )
}

async function readRecentNativeDiagnostics(): Promise<NativeDiagnosticReadResult> {
  const root = path.join(app.getPath('userData'), 'logs', 'native-media-diagnostics')
  const entries = await readdir(root, { withFileTypes: true }).catch(() => [])
  const discoveredSessions = await Promise.all(
    entries
      .filter((entry) => entry.isDirectory() && entry.name.startsWith('native-'))
      .map(async (entry) => {
        const directory = path.join(root, entry.name)
        const files = await readdir(directory, { withFileTypes: true }).catch(() => [])
        const diagnostics = (
          await Promise.all(
            files
              .filter((file) => file.isFile() && file.name.endsWith('.jsonl'))
              .map(async (file) => {
                const filePath = path.join(directory, file.name)
                const metadata = await stat(filePath).catch(() => null)
                if (!metadata) return null
                return {
                  filePath,
                  fileName: file.name,
                  size: metadata.size,
                  modifiedAt: metadata.mtimeMs,
                }
              }),
          )
        ).filter((file): file is NonNullable<typeof file> => file !== null)
        const directoryModifiedAt = await stat(directory)
          .then((metadata) => metadata.mtimeMs)
          .catch(() => 0)
        return {
          files: diagnostics,
          modifiedAt: diagnostics.reduce(
            (latest, file) => Math.max(latest, file.modifiedAt),
            directoryModifiedAt,
          ),
        }
      }),
  )
  discoveredSessions.sort((a, b) => b.modifiedAt - a.modifiedAt)
  const sessions = discoveredSessions.slice(0, MAX_NATIVE_SESSIONS)
  const candidates = sessions.flatMap((session) => session.files)
  const budgets = allocateFairReadBudgets(
    candidates.map((candidate) => candidate.size),
    MAX_NATIVE_BYTES,
  )
  const included: NativeDiagnosticFile[] = []
  for (const [index, candidate] of candidates.entries()) {
    const budget = budgets[index] ?? 0
    if (budget <= 0) continue
    const { value, truncated } = await readBoundedTail(candidate.filePath, budget)
    let bounded = value
    if (truncated) {
      const firstCompleteLine = bounded.indexOf(0x0a)
      bounded =
        firstCompleteLine === -1
          ? Buffer.alloc(0)
          : bounded.subarray(firstCompleteLine + 1)
    }
    if (bounded.length === 0) continue
    included.push({
      value: bounded.toString('utf8'),
      source: diagnosticSourceForFile(candidate.fileName),
      bytes: bounded.length,
      truncated,
    })
  }
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
  if (fileName === 'electron-main.jsonl') return 'electron-main'
  if (fileName === 'utility.jsonl') return 'utility'
  return 'native'
}

async function readBoundedTail(filePath: string, maximumBytes: number) {
  let handle: Awaited<ReturnType<typeof open>> | null = null
  try {
    handle = await open(filePath, 'r')
    const { size } = await handle.stat()
    const length = Math.min(size, maximumBytes)
    if (length <= 0) return { value: Buffer.alloc(0), truncated: size > 0 }

    const value = Buffer.allocUnsafe(length)
    const position = Math.max(0, size - length)
    let offset = 0
    while (offset < length) {
      const { bytesRead } = await handle.read(
        value,
        offset,
        length - offset,
        position + offset,
      )
      if (bytesRead === 0) break
      offset += bytesRead
    }
    return {
      value: value.subarray(0, offset),
      truncated: position > 0,
    }
  } catch {
    return { value: Buffer.alloc(0), truncated: false }
  } finally {
    await handle?.close().catch(() => undefined)
  }
}
