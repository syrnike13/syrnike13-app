import { open, readdir, stat } from 'node:fs/promises'
import path from 'node:path'
import { gzipSync } from 'node:zlib'

import { app } from 'electron'
import type {
  DiagnosticEnvelope,
  DiagnosticEnvelopeSource,
  DiagnosticJsonValue,
} from '@syrnike13/platform'

const MAX_RENDERER_BYTES = 2 * 1024 * 1024
const MAX_NATIVE_BYTES = 6 * 1024 * 1024
const MAX_NATIVE_SESSIONS = 3
const DIAGNOSTIC_SCHEMA = 'syrnike.diagnostic' as const
const DIAGNOSTIC_SCHEMA_VERSION = 1 as const

export async function createDesktopDiagnosticBundle(rendererJsonl: string) {
  if (typeof rendererJsonl !== 'string') {
    throw new Error('Diagnostic records must be a string')
  }
  if (Buffer.byteLength(rendererJsonl) > MAX_RENDERER_BYTES) {
    throw new Error('Renderer diagnostic records are too large')
  }

  const rendererRecords = normalizeJsonl(rendererJsonl, 'renderer', true)
  const nativeRecords = normalizeJsonl(
    await readRecentNativeDiagnostics(),
    'native',
    false,
  )
  return new Uint8Array(
    gzipSync([...rendererRecords, ...nativeRecords].join('\n'), { level: 6 }),
  )
}

function normalizeJsonl(
  value: string,
  fallbackSource: DiagnosticEnvelopeSource,
  strict: boolean,
) {
  const records: string[] = []
  for (const line of value.split(/\r?\n/)) {
    if (!line.trim()) continue
    try {
      const normalized = normalizeRecord(JSON.parse(line), fallbackSource)
      if (!normalized) throw new Error('Unsupported diagnostic record')
      records.push(JSON.stringify(normalized))
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

async function readRecentNativeDiagnostics() {
  const root = path.join(app.getPath('userData'), 'logs', 'native-media-diagnostics')
  const entries = await readdir(root, { withFileTypes: true }).catch(() => [])
  const sessions = await Promise.all(
    entries
      .filter((entry) => entry.isDirectory() && entry.name.startsWith('native-'))
      .map(async (entry) => {
        const directory = path.join(root, entry.name)
        return { directory, modifiedAt: (await stat(directory)).mtimeMs }
      }),
  )
  sessions.sort((a, b) => b.modifiedAt - a.modifiedAt)

  let remaining = MAX_NATIVE_BYTES
  const chunks: string[] = []
  for (const session of sessions.slice(0, MAX_NATIVE_SESSIONS)) {
    const files = await readdir(session.directory, { withFileTypes: true }).catch(
      () => [],
    )
    for (const file of files) {
      if (!file.isFile() || !file.name.endsWith('.jsonl') || remaining <= 0) continue
      const filePath = path.join(session.directory, file.name)
      const { value, truncated } = await readBoundedTail(filePath, remaining)
      let bounded = value
      if (truncated) {
        const firstCompleteLine = bounded.indexOf(0x0a)
        bounded =
          firstCompleteLine === -1
            ? Buffer.alloc(0)
            : bounded.subarray(firstCompleteLine + 1)
      }
      chunks.push(bounded.toString('utf8'))
      remaining -= bounded.length
    }
  }
  return chunks.join('\n')
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
