import type {
  NativeDiagnosticIncident,
  NativeDiagnosticIncidentBatch,
  NativeDiagnosticIncidentSeverity,
  RendererDiagnosticIncident,
} from '@syrnike13/platform'

import type { DiagnosticLogRecord } from './diagnostic-log'
import { redactSensitiveText } from './contract'

const MAX_PENDING_INCIDENTS = 100
const MAX_INCIDENT_FINGERPRINTS = 1_000
const REPEAT_WINDOW_MS = 5_000
const INCIDENT_LEASE_MS = 2 * 60 * 1_000
const NATIVE_AUTOMATIC_COOLDOWN_MS = 60_000
const RENDERER_AUTOMATIC_COOLDOWN_MS = 10 * 60 * 1_000
const RETRY_BACKOFF_MS = [5_000, 15_000, 60_000, 5 * 60_000] as const
const WARNING_EVENTS = new Set([
  'request_rejected_queue_full',
  'restart_scheduled',
  'runtime_event_dropped_out_of_order',
])
const FATAL_EVENTS = new Set([
  'native_contract_corruption',
  'restart_aborted_circuit_open',
  'runtime_contract_corrupt',
  'utility_crashed',
])
const FAILURE_EVENTS = new Set([
  ...WARNING_EVENTS,
  ...FATAL_EVENTS,
  'adapter_exited',
  'adapter_recycled',
  'bootstrap_failed',
  'dispose_failed',
  'frame_delivery_rejected',
  'handshake_failed',
  'probe_reply_error',
  'probe_timed_out',
  'request_post_failed',
  'request_rejected',
  'request_rejected_not_ready',
  'request_reply_error',
  'request_timed_out',
  'runtime_degraded',
  'screen_publication_failed',
  'session_rotation_failed',
])
const NON_INCIDENT_PROJECTIONS = new Set([
  'command',
  'snapshot',
  'state_changed',
])

const pending: NativeDiagnosticIncident[] = []
const lastIncidentAt = new Map<string, number>()
const correlationAliases = new Map<string, string>()
const lastAcknowledgedAt = new Map<string, number>()
const retryState = new Map<string, { attempt: number; notBefore: number }>()
let leasedBatch: (NativeDiagnosticIncidentBatch & { expiresAt: number }) | null = null
// undefined is the short bootstrap window before the stored auth session has
// been loaded. A string is compared only in memory and is never serialized into
// an incident or report. null means that logout/no-session has been confirmed.
let activeAccountId: string | null | undefined

export function configureNativeDiagnosticIncidentAccount(
  accountId: string | null,
) {
  const nextAccountId = normalizeAccountId(accountId)
  if (activeAccountId === undefined) {
    activeAccountId = nextAccountId
    if (nextAccountId === null) resetIncidentState()
    return
  }
  if (activeAccountId === nextAccountId) return
  resetIncidentState()
  activeAccountId = nextAccountId
}

export function captureNativeDiagnosticIncident(
  record: DiagnosticLogRecord,
  timestampMs = Date.now(),
) {
  if (activeAccountId === null) return null
  if (record.event === 'adapter_exited' && record.reason === 'expected') return null
  if (record.errorCode === 'stale_generation') return null
  if (NON_INCIDENT_PROJECTIONS.has(record.event)) return null
  if (!record.errorCode && !FAILURE_EVENTS.has(record.event)) return null

  const triggerCode = safeTriggerCode(
    `${record.scope}.${record.errorCode ?? record.event}`,
  )
  const identity = [
    record.scope,
    triggerCode,
    record.runtime,
    record.kind,
    record.lane,
    record.stage,
  ].join(':')
  const correlationId = incidentCorrelationId(record)
  const fingerprint = `${identity}:${correlationId ?? 'uncorrelated'}`
  const previous = touchIncidentFingerprint(fingerprint, timestampMs)
  if (previous !== undefined && timestampMs - previous < REPEAT_WINDOW_MS) {
    const existing = findPendingIncident(identity, correlationId)
    if (existing) {
      existing.timestampMs = timestampMs
      existing.occurrenceCount = (existing.occurrenceCount ?? 1) + 1
      return existing
    }
    // IPC has already cloned an active lease into the renderer. Preserve later
    // occurrences as a bounded follow-up instead of mutating evidence that the
    // upload executor can no longer observe.
    if (!hasLeasedIncident(identity, correlationId)) return null
  }

  const incident: NativeDiagnosticIncident = compactIncident({
    timestampMs,
    firstTimestampMs: timestampMs,
    occurrenceCount: 1,
    severity: incidentSeverity(record),
    triggerCode,
    identity,
    correlationId,
    area: 'native-runtime',
    cooldownMs: NATIVE_AUTOMATIC_COOLDOWN_MS,
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

export function captureRendererDiagnosticIncident(
  value: unknown,
  timestampMs = Date.now(),
) {
  if (!hasAuthenticatedAccount()) return false
  if (!isRendererDiagnosticIncident(value)) return false
  const area = safeTriggerCode(value.area)
  const triggerCode = safeTriggerCode(value.triggerCode)
  if (!area || !triggerCode) return false
  const identity = `renderer:${area}:${triggerCode}`
  const fingerprint = `${identity}:uncorrelated`
  const previous = touchIncidentFingerprint(fingerprint, timestampMs)
  if (previous !== undefined && timestampMs - previous < REPEAT_WINDOW_MS) {
    const existing = findPendingIncident(identity)
    if (existing) {
      existing.timestampMs = timestampMs
      existing.occurrenceCount = (existing.occurrenceCount ?? 1) + 1
      return true
    }
    if (!hasLeasedIncident(identity) && !lastAcknowledgedAt.has(identity)) {
      // The bounded pending queue may already have evicted the original. The
      // fingerprint still owns the repeat window, so do not create a duplicate.
      return true
    }
    // A repeat after a completed upload is a new occurrence. Keep it queued
    // behind the account-owned cooldown instead of losing it.
  }
  pending.push({
    timestampMs,
    firstTimestampMs: timestampMs,
    occurrenceCount: 1,
    severity: value.severity,
    triggerCode,
    identity,
    area,
    cooldownMs: Math.max(
      5_000,
      value.cooldownMs ?? RENDERER_AUTOMATIC_COOLDOWN_MS,
    ),
    scope: 'renderer',
    event: 'automatic_incident',
  })
  if (pending.length > MAX_PENDING_INCIDENTS) pending.shift()
  return true
}

export function captureRendererDiagnosticIncidentForAccount(
  accountId: unknown,
  value: unknown,
  timestampMs = Date.now(),
) {
  if (!isActiveAccount(accountId)) return false
  return captureRendererDiagnosticIncident(value, timestampMs)
}

export function leaseNativeDiagnosticIncidents(
  accountId: unknown,
  timestampMs = Date.now(),
) {
  if (!isActiveAccount(accountId)) return null
  if (leasedBatch && leasedBatch.expiresAt <= timestampMs) {
    deferIncidentRetry(leasedBatch.incidents, timestampMs)
    pending.unshift(...leasedBatch.incidents)
    while (pending.length > MAX_PENDING_INCIDENTS) pending.shift()
    leasedBatch = null
  }
  if (leasedBatch) {
    return {
      id: leasedBatch.id,
      accountId: leasedBatch.accountId,
      incidents: leasedBatch.incidents,
    }
  }
  const incidents = pending.filter((incident) => {
    const identity = incident.identity ??
      `${incident.scope}:${incident.triggerCode}`
    const acknowledgedAt = lastAcknowledgedAt.get(identity)
    const retry = retryState.get(identity)
    return (acknowledgedAt === undefined ||
      timestampMs - acknowledgedAt >= (incident.cooldownMs ?? 60_000)) &&
      (retry === undefined || timestampMs >= retry.notBefore)
  })
  if (incidents.length === 0) return null
  const eligible = new Set(incidents)
  for (let index = pending.length - 1; index >= 0; index -= 1) {
    if (pending[index] && eligible.has(pending[index]!)) pending.splice(index, 1)
  }

  leasedBatch = {
    id: crypto.randomUUID(),
    accountId,
    incidents,
    expiresAt: timestampMs + INCIDENT_LEASE_MS,
  }
  return {
    id: leasedBatch.id,
    accountId: leasedBatch.accountId,
    incidents: leasedBatch.incidents,
  }
}

export function acknowledgeNativeDiagnosticIncidents(
  accountId: unknown,
  batchId: string,
  timestampMs = Date.now(),
) {
  if (!isActiveAccount(accountId)) return false
  if (leasedBatch?.id !== batchId || leasedBatch.accountId !== accountId) return false
  for (const incident of leasedBatch.incidents) {
    const identity = incident.identity ??
      `${incident.scope}:${incident.triggerCode}`
    retryState.delete(identity)
    lastAcknowledgedAt.delete(identity)
    lastAcknowledgedAt.set(identity, timestampMs)
  }
  while (lastAcknowledgedAt.size > MAX_INCIDENT_FINGERPRINTS) {
    const oldest = lastAcknowledgedAt.keys().next().value
    if (oldest === undefined) break
    lastAcknowledgedAt.delete(oldest)
  }
  leasedBatch = null
  return true
}

export function releaseNativeDiagnosticIncidents(
  accountId: unknown,
  batchId: string,
  timestampMs = Date.now(),
) {
  if (!isActiveAccount(accountId)) return false
  if (leasedBatch?.id !== batchId || leasedBatch.accountId !== accountId) return false
  deferIncidentRetry(leasedBatch.incidents, timestampMs)
  pending.unshift(...leasedBatch.incidents)
  while (pending.length > MAX_PENDING_INCIDENTS) pending.shift()
  leasedBatch = null
  return true
}

export function clearNativeDiagnosticIncidentsForTests() {
  resetIncidentState()
  activeAccountId = undefined
}

function resetIncidentState() {
  pending.length = 0
  lastIncidentAt.clear()
  correlationAliases.clear()
  lastAcknowledgedAt.clear()
  retryState.clear()
  leasedBatch = null
}

function normalizeAccountId(accountId: string | null) {
  if (accountId === null) return null
  const normalized = accountId.trim()
  return normalized.length > 0 ? normalized : null
}

function hasAuthenticatedAccount() {
  return typeof activeAccountId === 'string'
}

function isActiveAccount(accountId: unknown): accountId is string {
  return typeof activeAccountId === 'string' && accountId === activeAccountId
}

function touchIncidentFingerprint(fingerprint: string, timestampMs: number) {
  const previous = lastIncidentAt.get(fingerprint)
  lastIncidentAt.delete(fingerprint)
  lastIncidentAt.set(fingerprint, timestampMs)
  pruneTimedMap(lastIncidentAt, timestampMs, REPEAT_WINDOW_MS)
  return previous
}

function pruneTimedMap(
  values: Map<string, number>,
  timestampMs: number,
  ttlMs: number,
) {
  for (const [key, lastSeenAt] of values) {
    if (timestampMs - lastSeenAt >= ttlMs) values.delete(key)
  }
  while (values.size > MAX_INCIDENT_FINGERPRINTS) {
    const oldest = values.keys().next().value
    if (oldest === undefined) break
    values.delete(oldest)
  }
}

function findPendingIncident(identity: string, correlationId?: string) {
  for (let index = pending.length - 1; index >= 0; index -= 1) {
    const candidate = pending[index]
    if (
      candidate?.identity === identity &&
      candidate.correlationId === correlationId
    ) {
      return candidate
    }
  }
  return undefined
}

function hasLeasedIncident(identity: string, correlationId?: string) {
  const leased = leasedBatch?.incidents
  if (!leased) return false
  for (let index = leased.length - 1; index >= 0; index -= 1) {
    const candidate = leased[index]
    if (
      candidate?.identity === identity &&
      candidate.correlationId === correlationId
    ) {
      return true
    }
  }
  return false
}

function incidentSeverity(
  record: DiagnosticLogRecord,
): NativeDiagnosticIncidentSeverity {
  if (FATAL_EVENTS.has(record.event)) return 'fatal'
  if (WARNING_EVENTS.has(record.event)) return 'warning'
  return 'error'
}

function incidentCorrelationId(record: DiagnosticLogRecord) {
  const source = record.requestId ?? record.sessionId ?? record.operation
  if (!source) return undefined
  const key = `${record.scope}:${source}`
  const existing = correlationAliases.get(key)
  if (existing) return existing
  const alias = `incident-${crypto.randomUUID()}`
  correlationAliases.set(key, alias)
  while (correlationAliases.size > MAX_INCIDENT_FINGERPRINTS) {
    const oldest = correlationAliases.keys().next().value
    if (oldest === undefined) break
    correlationAliases.delete(oldest)
  }
  return alias
}

function deferIncidentRetry(
  incidents: NativeDiagnosticIncident[],
  timestampMs: number,
) {
  for (const incident of incidents) {
    const identity = incident.identity ??
      `${incident.scope}:${incident.triggerCode}`
    const previous = retryState.get(identity)
    const attempt = Math.min(
      (previous?.attempt ?? 0) + 1,
      RETRY_BACKOFF_MS.length,
    )
    retryState.delete(identity)
    retryState.set(identity, {
      attempt,
      notBefore: timestampMs + RETRY_BACKOFF_MS[attempt - 1]!,
    })
  }
  while (retryState.size > MAX_INCIDENT_FINGERPRINTS) {
    const oldest = retryState.keys().next().value
    if (oldest === undefined) break
    retryState.delete(oldest)
  }
}

function safeTriggerCode(value: string) {
  return value.replace(/[^A-Za-z0-9_.-]/g, '_').slice(0, 128)
}

function isRendererDiagnosticIncident(
  value: unknown,
): value is RendererDiagnosticIncident {
  if (!value || typeof value !== 'object') return false
  const candidate = value as Record<string, unknown>
  return typeof candidate.area === 'string' &&
    candidate.area.length > 0 &&
    candidate.area.length <= 128 &&
    typeof candidate.triggerCode === 'string' &&
    candidate.triggerCode.length > 0 &&
    candidate.triggerCode.length <= 128 &&
    (candidate.severity === 'warning' ||
      candidate.severity === 'error' ||
      candidate.severity === 'fatal') &&
    (candidate.cooldownMs === undefined ||
      (typeof candidate.cooldownMs === 'number' &&
        Number.isFinite(candidate.cooldownMs) &&
        candidate.cooldownMs >= 0))
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
