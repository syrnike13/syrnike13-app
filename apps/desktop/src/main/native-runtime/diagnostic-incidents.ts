import type {
  NativeDiagnosticIncident,
  NativeDiagnosticIncidentBatch,
  NativeDiagnosticIncidentSeverity,
} from '@syrnike13/platform'

import type { DiagnosticLogRecord } from './diagnostic-log'
import { redactSensitiveText } from './contract'

const MAX_PENDING_INCIDENTS = 100
const REPEAT_WINDOW_MS = 5_000
const INCIDENT_LEASE_MS = 2 * 60 * 1_000
const INCIDENT_SIGNAL =
  /error|fail|timed_out|timeout|rejected|queue_full|exit|restart|recycl|degraded|lost|unresponsive|stalled|incompatible|corrupt|fatal|crash|dropped_out_of_order/i
const FATAL_SIGNAL = /circuit_open|corrupt|fatal|crash/i
const WARNING_SIGNAL = /queue_full|restart_scheduled|degraded|dropped_out_of_order/i

const pending: NativeDiagnosticIncident[] = []
const lastIncidentAt = new Map<string, number>()
let leasedBatch: (NativeDiagnosticIncidentBatch & { expiresAt: number }) | null = null

export function captureNativeDiagnosticIncident(
  record: DiagnosticLogRecord,
  timestampMs = Date.now(),
) {
  const signal = [
    record.event,
    record.status,
    record.reason,
    record.errorCode,
  ]
    .filter(Boolean)
    .join(':')
  if (record.event === 'adapter_exited' && record.reason === 'expected') return null
  if (!record.errorCode && !INCIDENT_SIGNAL.test(signal)) return null

  const fingerprint = [
    record.scope,
    record.event,
    record.status,
    record.reason,
    record.errorCode,
    record.stage,
  ].join(':')
  const previous = lastIncidentAt.get(fingerprint)
  if (previous !== undefined && timestampMs - previous < REPEAT_WINDOW_MS) {
    return null
  }
  lastIncidentAt.set(fingerprint, timestampMs)

  const incident: NativeDiagnosticIncident = compactIncident({
    timestampMs,
    severity: incidentSeverity(signal),
    triggerCode: safeTriggerCode(`${record.scope}.${record.event}`),
    scope: record.scope,
    event: record.event,
    nativeEventType: record.nativeEventType,
    runtime: record.runtime,
    kind: record.kind,
    lane: record.lane,
    stage: record.stage,
    status: record.status,
    reason: redactedText(record.reason),
    message: redactedText(record.message),
    errorCode: record.errorCode,
    restartCount: record.restartCount,
    durationMs: record.durationMs,
    timeoutMs: record.timeoutMs,
  })
  pending.push(incident)
  if (pending.length > MAX_PENDING_INCIDENTS) pending.shift()
  return incident
}

export function leaseNativeDiagnosticIncidents(timestampMs = Date.now()) {
  if (leasedBatch && leasedBatch.expiresAt <= timestampMs) {
    pending.unshift(...leasedBatch.incidents)
    while (pending.length > MAX_PENDING_INCIDENTS) pending.shift()
    leasedBatch = null
  }
  if (leasedBatch) {
    return { id: leasedBatch.id, incidents: leasedBatch.incidents }
  }
  if (pending.length === 0) return null

  leasedBatch = {
    id: crypto.randomUUID(),
    incidents: pending.splice(0, pending.length),
    expiresAt: timestampMs + INCIDENT_LEASE_MS,
  }
  return { id: leasedBatch.id, incidents: leasedBatch.incidents }
}

export function acknowledgeNativeDiagnosticIncidents(batchId: string) {
  if (leasedBatch?.id !== batchId) return false
  leasedBatch = null
  return true
}

export function releaseNativeDiagnosticIncidents(batchId: string) {
  if (leasedBatch?.id !== batchId) return false
  pending.unshift(...leasedBatch.incidents)
  while (pending.length > MAX_PENDING_INCIDENTS) pending.shift()
  leasedBatch = null
  return true
}

export function clearNativeDiagnosticIncidentsForTests() {
  pending.length = 0
  lastIncidentAt.clear()
  leasedBatch = null
}

function incidentSeverity(signal: string): NativeDiagnosticIncidentSeverity {
  if (FATAL_SIGNAL.test(signal)) return 'fatal'
  if (WARNING_SIGNAL.test(signal)) return 'warning'
  return 'error'
}

function safeTriggerCode(value: string) {
  return value.replace(/[^A-Za-z0-9_.-]/g, '_').slice(0, 128)
}

function redactedText(value: string | undefined) {
  return value ? redactSensitiveText(value).slice(0, 4_096) : undefined
}

function compactIncident(
  incident: NativeDiagnosticIncident,
): NativeDiagnosticIncident {
  return Object.fromEntries(
    Object.entries(incident).filter(([, value]) => value !== undefined),
  ) as NativeDiagnosticIncident
}
