export const DIAGNOSTIC_SCHEMA = 'syrnike.diagnostic' as const
export const DIAGNOSTIC_SCHEMA_VERSION = 1 as const

export type DiagnosticJsonValue =
  | null
  | boolean
  | number
  | string
  | DiagnosticJsonValue[]
  | { [key: string]: DiagnosticJsonValue }

export type DiagnosticEnvelopeSource =
  | 'web'
  | 'renderer'
  | 'electron-main'
  | 'utility'
  | 'native'

export type DiagnosticEnvelope = {
  schema: typeof DIAGNOSTIC_SCHEMA
  version: typeof DIAGNOSTIC_SCHEMA_VERSION
  record_type: 'manifest' | 'event'
  timestamp_ms: number
  source: DiagnosticEnvelopeSource
  event: string
  data: { [key: string]: DiagnosticJsonValue }
}

export type NativeDiagnosticIncidentSeverity = 'warning' | 'error' | 'fatal'

export type NativeDiagnosticIncident = {
  timestampMs: number
  severity: NativeDiagnosticIncidentSeverity
  triggerCode: string
  scope: string
  event: string
  nativeEventType?: string
  runtime?: string
  kind?: string
  lane?: string
  stage?: string
  status?: string
  reason?: string
  message?: string
  errorCode?: string
  restartCount?: number
  durationMs?: number
  timeoutMs?: number
}

export type NativeDiagnosticIncidentBatch = {
  id: string
  incidents: NativeDiagnosticIncident[]
}
