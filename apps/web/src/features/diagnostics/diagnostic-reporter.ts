import type { SyrnikeDesktopApi } from '@syrnike13/platform'

import { apiRequest } from '#/lib/api/client'
import { config } from '#/lib/config'
import { loadDesktopLocalSettings } from '#/features/settings/desktop-local-settings-client'
import { readBrowserDiagnosticReportsEnabled } from './diagnostic-preferences'

type DiagnosticSeverity = 'warning' | 'error' | 'fatal'

type DiagnosticEvent = {
  timestamp: number
  area: string
  event: string
  data?: DiagnosticValue
}

type DiagnosticValue =
  | null
  | boolean
  | number
  | string
  | DiagnosticValue[]
  | { [key: string]: DiagnosticValue }

export type SendDiagnosticReportOptions = {
  token: string
  desktop: SyrnikeDesktopApi | null
  area: string
  severity: DiagnosticSeverity
  triggerCode: string
  description?: string
  context?: unknown
  automatic?: boolean
}

type DiagnosticReportCreated = { id: string; created_at: number }

const MAX_EVENTS = 800
const MAX_EVENT_BYTES = 16 * 1024
const MAX_EVENT_BUFFER_BYTES = 1_500 * 1024
const MAX_STRING_LENGTH = 4_096
const AUTOMATIC_COOLDOWN_MS = 10 * 60 * 1_000
const SENSITIVE_KEY =
  /token|authorization|cookie|password|secret|identity|participant|user(?:id)?|channel(?:id)?|room|device|label|source(?:id)?|window|path|address|hostname|candidate/i
const automaticReports = new Map<string, number>()
const events: string[] = []
let eventBufferBytes = 0

export function recordDiagnosticEvent(area: string, event: string, data?: unknown) {
  const record: DiagnosticEvent = {
    timestamp: Date.now(),
    area: safeIdentifier(area, 'unknown'),
    event: safeIdentifier(event, 'unknown'),
  }
  const sanitized = sanitizeDiagnosticValue(data)
  if (sanitized !== undefined) record.data = sanitized
  let serialized = JSON.stringify(record)
  let bytes = utf8Bytes(serialized)
  if (bytes > MAX_EVENT_BYTES) {
    serialized = JSON.stringify({
      timestamp: record.timestamp,
      area: record.area,
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
  const automaticKey = options.automatic
    ? `${options.area}:${options.triggerCode}`
    : null
  if (options.automatic) {
    if (options.desktop) {
      const settings = await loadDesktopLocalSettings()
      if (!settings?.observability.diagnosticReports) return null
    } else if (!readBrowserDiagnosticReportsEnabled()) {
      return null
    }
    const previous = automaticReports.get(automaticKey!) ?? 0
    if (Date.now() - previous < AUTOMATIC_COOLDOWN_MS) return null
    automaticReports.set(automaticKey!, Date.now())
  }

  try {
    recordDiagnosticEvent(options.area, 'report_triggered', {
      severity: options.severity,
      triggerCode: options.triggerCode,
      context: options.context,
    })
    const manifest = {
      type: 'manifest',
      version: 1,
      generatedAt: new Date().toISOString(),
      source: options.desktop ? 'desktop' : 'web',
      appVersion: config.appVersion,
      releaseChannel: config.releaseChannel,
      platform: options.desktop?.platform.os ?? browserPlatform(),
      area: safeIdentifier(options.area, 'client'),
      severity: options.severity,
      triggerCode: safeIdentifier(options.triggerCode, 'unknown_error'),
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
        source: manifest.source,
        release_channel: normalizedReleaseChannel(config.releaseChannel),
        app_version: safeIdentifier(config.appVersion, 'unknown'),
        platform: safeIdentifier(manifest.platform, 'unknown'),
        area: manifest.area,
        severity: options.severity,
        trigger_code: manifest.triggerCode,
        description: (options.description ?? '').slice(0, 1_000),
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
  events.length = 0
  eventBufferBytes = 0
  automaticReports.clear()
}

function sanitizeDiagnosticValue(value: unknown, depth = 0): DiagnosticValue | undefined {
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
  const result: Record<string, DiagnosticValue> = {}
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
    .replace(/\b[A-Za-z]:[\\/][^\r\n"']+/g, '[redacted-path]')
    .replace(/https?:\/\/[^\s"']+/g, '[redacted-url]')
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
