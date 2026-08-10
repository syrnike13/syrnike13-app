import { Schema } from 'effect'

export const DIAGNOSTIC_SCHEMA = 'syrnike.diagnostic' as const
export const DIAGNOSTIC_SCHEMA_VERSION = 1 as const

export type DiagnosticJsonValue = Schema.Json

export const DiagnosticEnvelopeSourceSchema = Schema.Literals([
  'web',
  'renderer',
  'electron-main',
  'utility',
  'native',
])

export const DiagnosticEnvelopeSchema = Schema.Struct({
  schema: Schema.Literal(DIAGNOSTIC_SCHEMA),
  version: Schema.Literal(DIAGNOSTIC_SCHEMA_VERSION),
  record_type: Schema.Literals(['manifest', 'event']),
  timestamp_ms: Schema.Finite,
  source: DiagnosticEnvelopeSourceSchema,
  event: Schema.String,
  data: Schema.Record(Schema.String, Schema.Json),
})

export type DiagnosticEnvelopeSource =
  typeof DiagnosticEnvelopeSourceSchema.Type
export type DiagnosticEnvelope = {
  schema: typeof DIAGNOSTIC_SCHEMA
  version: typeof DIAGNOSTIC_SCHEMA_VERSION
  record_type: 'manifest' | 'event'
  timestamp_ms: number
  source: DiagnosticEnvelopeSource
  event: string
  data: Record<string, DiagnosticJsonValue>
}

export const NativeDiagnosticIncidentSeveritySchema = Schema.Literals([
  'warning',
  'error',
  'fatal',
])

const optionalString = Schema.optional(Schema.String)
const optionalFiniteNumber = Schema.optional(Schema.Finite)
const optionalFiniteMetrics = Schema.optional(
  Schema.Record(Schema.String, Schema.Finite),
)

export const NativeDiagnosticIncidentSchema = Schema.Struct({
  timestampMs: Schema.Finite,
  firstTimestampMs: optionalFiniteNumber,
  occurrenceCount: optionalFiniteNumber,
  severity: NativeDiagnosticIncidentSeveritySchema,
  triggerCode: Schema.String,
  identity: optionalString,
  correlationId: optionalString,
  area: optionalString,
  cooldownMs: optionalFiniteNumber,
  scope: Schema.String,
  event: Schema.String,
  actionId: optionalString,
  operationId: optionalString,
  nativeEventType: optionalString,
  runtime: optionalString,
  kind: optionalString,
  lane: optionalString,
  stage: optionalString,
  commandStage: optionalString,
  outcome: optionalString,
  revision: optionalFiniteNumber,
  generation: optionalFiniteNumber,
  hostEpoch: optionalFiniteNumber,
  status: optionalString,
  reason: optionalString,
  message: optionalString,
  errorCode: optionalString,
  restartCount: optionalFiniteNumber,
  durationMs: optionalFiniteNumber,
  timeoutMs: optionalFiniteNumber,
  metrics: optionalFiniteMetrics,
})

export const RendererDiagnosticIncidentSchema = Schema.Struct({
  area: Schema.String.check(
    Schema.isMinLength(1),
    Schema.isMaxLength(128),
  ),
  severity: NativeDiagnosticIncidentSeveritySchema,
  triggerCode: Schema.String.check(
    Schema.isMinLength(1),
    Schema.isMaxLength(128),
  ),
  cooldownMs: Schema.optional(
    Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0)),
  ),
})

export const NativeDiagnosticIncidentBatchSchema = Schema.Struct({
  id: Schema.String,
  accountId: Schema.String,
  incidents: Schema.Array(NativeDiagnosticIncidentSchema),
})

type Mutable<Type> = {
  -readonly [Key in keyof Type]: Type[Key]
}

export type NativeDiagnosticIncidentSeverity =
  typeof NativeDiagnosticIncidentSeveritySchema.Type
export type NativeDiagnosticIncident = Mutable<
  typeof NativeDiagnosticIncidentSchema.Type
>
export type RendererDiagnosticIncident = Mutable<
  typeof RendererDiagnosticIncidentSchema.Type
>
export type NativeDiagnosticIncidentBatch = Omit<
  Mutable<typeof NativeDiagnosticIncidentBatchSchema.Type>,
  'incidents'
> & {
  incidents: NativeDiagnosticIncident[]
}
