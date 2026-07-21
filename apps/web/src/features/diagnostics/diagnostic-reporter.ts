import {
  DIAGNOSTIC_SCHEMA,
  DIAGNOSTIC_SCHEMA_VERSION,
  type DiagnosticEnvelope,
  type DiagnosticJsonValue,
  type SyrnikeDesktopApi,
} from '@syrnike13/platform'

import { apiRequest } from '#/lib/api/client'
import { config } from '#/lib/config'
import { loadDesktopLocalSettings } from '#/features/settings/desktop-local-settings-client'
import { readBrowserDiagnosticReportsEnabled } from './diagnostic-preferences'
import { clearPendingAutomaticDiagnosticIncidents } from './automatic-diagnostic-incidents'

type DiagnosticSeverity = 'warning' | 'error' | 'fatal'

export type SendDiagnosticReportOptions = {
  token: string
  desktop: SyrnikeDesktopApi | null
  area: string
  severity: DiagnosticSeverity
  triggerCode: string
  description?: string
  context?: unknown
  automatic?: boolean
  automaticLease?: boolean
  automaticCooldownMs?: number
}

type DiagnosticReportCreated = { id: string; created_at: number }

type RecordDiagnosticEventOptions = {
  /** Collapse identical sanitized payloads while retaining periodic heartbeats. */
  dedupeKey?: string
  heartbeatMs?: number
}

type DeduplicatedEventState = {
  fingerprint: string
  lastRecordedAt: number
  suppressed: number
}

const MAX_EVENTS = 800
const MAX_EVENT_BYTES = 16 * 1024
const MAX_EVENT_BUFFER_BYTES = 1_500 * 1024
const MAX_STRING_LENGTH = 4_096
const AUTOMATIC_COOLDOWN_MS = 10 * 60 * 1_000
const SENSITIVE_KEY =
  /token|authorization|cookie|password|secret|identity|participant|user(?:id)?|channel(?:id)?|room|device|label|source(?:id)?|window|path|address|hostname|candidate/i
const automaticReports = new Map<string, number>()
const deduplicatedEvents = new Map<string, DeduplicatedEventState>()
const events: string[] = []
let eventBufferBytes = 0
let diagnosticAccountId: string | null | undefined
let diagnosticAccountRevision = 0

export function configureRendererDiagnosticAccount(accountId: string | null) {
  const normalized = accountId?.trim() || null
  if (diagnosticAccountId === normalized) return
  diagnosticAccountId = normalized
  diagnosticAccountRevision += 1
  clearDiagnosticState()
  clearPendingAutomaticDiagnosticIncidents()
}

export function recordDiagnosticEvent(
  area: string,
  event: string,
  data?: unknown,
  options: RecordDiagnosticEventOptions = {},
) {
  const timestampMs = Date.now()
  const sanitized = sanitizeDiagnosticValue(data)
  const dedupeKey = options.dedupeKey
  let deduplication: DiagnosticJsonValue | undefined
  if (dedupeKey) {
    const fingerprint = JSON.stringify(sanitized)
    const previous = deduplicatedEvents.get(dedupeKey)
    const heartbeatMs = Math.max(1_000, options.heartbeatMs ?? 30_000)
    if (
      previous?.fingerprint === fingerprint &&
      timestampMs - previous.lastRecordedAt < heartbeatMs
    ) {
      previous.suppressed += 1
      return
    }
    if (previous?.suppressed) {
      deduplication = {
        repeated_events_omitted: previous.suppressed,
        elapsed_ms: Math.max(0, timestampMs - previous.lastRecordedAt),
      }
    }
    deduplicatedEvents.set(dedupeKey, {
      fingerprint,
      lastRecordedAt: timestampMs,
      suppressed: 0,
    })
  }

  const record: DiagnosticEnvelope = {
    schema: DIAGNOSTIC_SCHEMA,
    version: DIAGNOSTIC_SCHEMA_VERSION,
    record_type: 'event',
    timestamp_ms: timestampMs,
    source: 'renderer',
    event: `${safeIdentifier(area, 'unknown')}.${safeIdentifier(event, 'unknown')}`,
    data: {},
  }
  if (sanitized !== undefined) record.data.payload = sanitized
  if (deduplication !== undefined) record.data.deduplication = deduplication
  let serialized = JSON.stringify(record)
  let bytes = utf8Bytes(serialized)
  if (bytes > MAX_EVENT_BYTES) {
    serialized = JSON.stringify({
      schema: DIAGNOSTIC_SCHEMA,
      version: DIAGNOSTIC_SCHEMA_VERSION,
      record_type: 'event',
      timestamp_ms: record.timestamp_ms,
      source: 'renderer',
      event: record.event,
      data: { omitted: 'event_too_large' },
    })
    bytes = utf8Bytes(serialized)
  }
  events.push(serialized)
  eventBufferBytes += bytes + 1
  while (events.length > MAX_EVENTS || eventBufferBytes > MAX_EVENT_BUFFER_BYTES) {
    const removed = events.shift()
    if (removed) eventBufferBytes -= utf8Bytes(removed) + 1
  }
}

export async function sendDiagnosticReport(
  options: SendDiagnosticReportOptions,
): Promise<DiagnosticReportCreated | null> {
  const accountRevision = diagnosticAccountRevision
  const automaticKey = options.automatic && !options.automaticLease
    ? `${options.area}:${options.triggerCode}`
    : null
  if (options.automatic) {
    if (options.desktop) {
      const settings = await loadDesktopLocalSettings()
      if (!settings?.observability.diagnosticReports) return null
    } else if (!readBrowserDiagnosticReportsEnabled()) {
      return null
    }
    if (accountRevision !== diagnosticAccountRevision) return null
    if (automaticKey) {
      const previous = automaticReports.get(automaticKey) ?? 0
      const cooldownMs = Math.max(
        5_000,
        options.automaticCooldownMs ?? AUTOMATIC_COOLDOWN_MS,
      )
      if (Date.now() - previous < cooldownMs) return null
      automaticReports.set(automaticKey, Date.now())
    }
  }

  try {
    recordDiagnosticEvent(options.area, 'report_triggered', {
      severity: options.severity,
      triggerCode: options.triggerCode,
      context: options.context,
    })
    const reportSource = options.desktop ? 'desktop' : 'web'
    const platform = options.desktop?.platform.os ?? browserPlatform()
    const area = safeIdentifier(options.area, 'client')
    const triggerCode = safeIdentifier(options.triggerCode, 'unknown_error')
    const releaseChannel = normalizedReleaseChannel(config.releaseChannel)
    const appVersion = safeIdentifier(config.appVersion, 'unknown')
    const manifest: DiagnosticEnvelope = {
      schema: DIAGNOSTIC_SCHEMA,
      version: DIAGNOSTIC_SCHEMA_VERSION,
      record_type: 'manifest',
      timestamp_ms: Date.now(),
      source: options.desktop ? 'renderer' : 'web',
      event: 'report_manifest',
      data: {
        source: reportSource,
        release_channel: releaseChannel,
        app_version: appVersion,
        platform: safeIdentifier(platform, 'unknown'),
        area,
        severity: options.severity,
        trigger_code: triggerCode,
      },
    }
    const jsonl = [JSON.stringify(manifest), ...events].join('\n')
    const compressed = options.desktop
      ? await options.desktop.diagnostics.createBundle(jsonl)
      : await gzipText(jsonl)

    return await apiRequest<DiagnosticReportCreated>('/diagnostics/reports', {
      method: 'POST',
      token: options.token,
      body: {
        version: 1,
        source: reportSource,
        release_channel: releaseChannel,
        app_version: appVersion,
        platform: safeIdentifier(platform, 'unknown'),
        area,
        severity: options.severity,
        trigger_code: triggerCode,
        description: sanitizeText(options.description ?? '').slice(0, 1_000),
        payload: bytesToBase64(compressed),
      },
    })
  } catch (error) {
    if (automaticKey) automaticReports.delete(automaticKey)
    throw error
  }
}

export function diagnosticEventCount() {
  return events.length
}

export function diagnosticEventsJsonForTests() {
  return `[${events.join(',')}]`
}

export function clearDiagnosticEventsForTests() {
  diagnosticAccountId = undefined
  diagnosticAccountRevision = 0
  clearDiagnosticState()
}

function clearDiagnosticState() {
  events.length = 0
  eventBufferBytes = 0
  automaticReports.clear()
  deduplicatedEvents.clear()
}

function sanitizeDiagnosticValue(
  value: unknown,
  depth = 0,
): DiagnosticJsonValue | undefined {
  if (value == null) return null
  if (typeof value === 'boolean') return value
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined
  if (typeof value === 'string') return sanitizeText(value)
  if (depth >= 5) return '[omitted]'
  if (Array.isArray(value)) {
    return value.slice(0, 50).flatMap((entry) => {
      const sanitized = sanitizeDiagnosticValue(entry, depth + 1)
      return sanitized === undefined ? [] : [sanitized]
    })
  }
  if (typeof value !== 'object') return undefined
  const result: Record<string, DiagnosticJsonValue> = {}
  for (const [key, nested] of Object.entries(value).slice(0, 80)) {
    if (SENSITIVE_KEY.test(key) || key === '__proto__' || key === 'constructor') continue
    const sanitized = sanitizeDiagnosticValue(nested, depth + 1)
    if (sanitized !== undefined) result[safeIdentifier(key, 'field')] = sanitized
  }
  return result
}

function sanitizeText(value: string) {
  return value
    .replace(/\b(?:Bearer\s+)?[A-Za-z0-9_-]{32,}\b/gi, '[redacted]')
    .replace(/\bfile:\/\/[^\s"'<>]+/gi, '[redacted-path]')
    .replace(/\b[A-Za-z]:[\\/][^\r\n"']+/g, '[redacted-path]')
    .replace(/https?:\/\/[^\s"']+/g, '[redacted-url]')
    .replace(
      /(^|[\s("'=])\/(?:[^/\s"'<>]+\/)*[^/\s"'<>]+/g,
      '$1[redacted-path]',
    )
    .slice(0, MAX_STRING_LENGTH)
}

function safeIdentifier(value: string, fallback: string) {
  const normalized = value.replace(/[^A-Za-z0-9_.-]/g, '_').slice(0, 128)
  return normalized || fallback
}

function normalizedReleaseChannel(value: string) {
  if (value === 'stable' || value === 'nightly') return value
  return 'development'
}

function browserPlatform() {
  if (typeof navigator === 'undefined') return 'server'
  return /Windows/i.test(navigator.userAgent)
    ? 'win32'
    : /Mac/i.test(navigator.userAgent)
      ? 'darwin'
      : 'browser'
}

async function gzipText(value: string) {
  const stream = new Blob([value]).stream().pipeThrough(new CompressionStream('gzip'))
  return new Uint8Array(await new Response(stream).arrayBuffer())
}

function bytesToBase64(bytes: Uint8Array) {
  let binary = ''
  const chunkSize = 32_768
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize))
  }
  return btoa(binary)
}

function utf8Bytes(value: string) {
  return new TextEncoder().encode(value).byteLength
}
