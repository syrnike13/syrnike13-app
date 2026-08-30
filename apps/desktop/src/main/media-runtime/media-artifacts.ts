import { createHash } from 'node:crypto'
import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'

import { Option, Schema } from 'effect'

import {
  MEDIA_LIFECYCLE_MAX_DEADLINE_MS,
  MEDIA_LIFECYCLE_MAX_DIAGNOSTIC_FIELDS,
  MEDIA_LIFECYCLE_MAX_DIAGNOSTIC_METRICS,
  MEDIA_LIFECYCLE_MAX_IDENTIFIER_LENGTH,
  MEDIA_LIFECYCLE_MAX_REMOTE_VIDEO_DEMANDS,
  MEDIA_LIFECYCLE_PROTOCOL_VERSION,
  MEDIA_LIFECYCLE_CONTROL_QUEUE_CAPACITY,
  MEDIA_LIFECYCLE_EVENT_QUEUE_CAPACITY,
  MEDIA_LIFECYCLE_START_TIMEOUT_MS,
  MEDIA_LIFECYCLE_PING_TIMEOUT_MS,
  MEDIA_LIFECYCLE_SHUTDOWN_TIMEOUT_MS,
} from './contract'

const MediaSha256Schema = Schema.String.check(
  Schema.isPattern(/^[0-9a-f]{64}$/i),
)

export const MediaArtifactManifestSchema = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  protocolVersion: Schema.Literal(MEDIA_LIFECYCLE_PROTOCOL_VERSION),
  platform: Schema.Literal('win32'),
  arch: Schema.Literal('x64'),
  appVersion: Schema.String,
  releaseChannel: Schema.Literals(['stable', 'nightly']),
  commitSha: Schema.String.check(Schema.isPattern(/^[0-9a-f]{40}$/i)),
  electronVersion: Schema.String,
  napiVersion: Schema.Literal(8),
  capabilities: Schema.Tuple([
    Schema.Literal('lifecycle'),
    Schema.Literal('control-v2'),
    Schema.Literal('diagnostics-v2'),
  ]),
  limits: Schema.Struct({
    controlQueue: Schema.Literal(MEDIA_LIFECYCLE_CONTROL_QUEUE_CAPACITY),
    eventQueue: Schema.Literal(MEDIA_LIFECYCLE_EVENT_QUEUE_CAPACITY),
    startDeadlineMs: Schema.Literal(MEDIA_LIFECYCLE_START_TIMEOUT_MS),
    pingDeadlineMs: Schema.Literal(MEDIA_LIFECYCLE_PING_TIMEOUT_MS),
    shutdownDeadlineMs: Schema.Literal(MEDIA_LIFECYCLE_SHUTDOWN_TIMEOUT_MS),
    maxIdentifierLength: Schema.Literal(MEDIA_LIFECYCLE_MAX_IDENTIFIER_LENGTH),
    maxRemoteVideoDemands: Schema.Literal(MEDIA_LIFECYCLE_MAX_REMOTE_VIDEO_DEMANDS),
    maxDiagnosticMetrics: Schema.Literal(MEDIA_LIFECYCLE_MAX_DIAGNOSTIC_METRICS),
    maxDiagnosticFields: Schema.Literal(MEDIA_LIFECYCLE_MAX_DIAGNOSTIC_FIELDS),
    maxRequestDeadlineMs: Schema.Literal(MEDIA_LIFECYCLE_MAX_DEADLINE_MS),
  }),
  files: Schema.Tuple([
    Schema.Struct({
      name: Schema.Literal('windows_media.node'),
      sha256: MediaSha256Schema,
    }),
  ]),
})

const JsonSchema = Schema.fromJsonString(Schema.Unknown)

export type MediaArtifactManifest = typeof MediaArtifactManifestSchema.Type

export type MediaArtifactExpectations = {
  appVersion: string
  commitSha: string
  electronVersion: string
  releaseChannel: 'stable' | 'nightly'
}

export function verifyMediaArtifactDistribution(
  mediaRoot: string,
  expected: MediaArtifactExpectations,
): MediaArtifactManifest {
  if (!path.isAbsolute(mediaRoot)) {
    throw new Error('Media artifact root must be absolute')
  }
  const entries = readdirSync(mediaRoot, { withFileTypes: true })
  if (entries.some((entry) => !entry.isFile())) {
    throw new Error('Media artifact distribution contains a nested entry')
  }
  const names = entries.map((entry) => entry.name).sort()
  if (
    JSON.stringify(names) !==
    JSON.stringify(['media-manifest.json', 'windows_media.node'])
  ) {
    throw new Error('Media artifact distribution has unexpected contents')
  }
  const parsed = Schema.decodeUnknownOption(JsonSchema)(
    readFileSync(path.join(mediaRoot, 'media-manifest.json'), 'utf8'),
  )
  if (Option.isNone(parsed)) {
    throw new Error('Media artifact manifest is not valid JSON')
  }
  const decoded = Schema.decodeUnknownOption(MediaArtifactManifestSchema, {
    onExcessProperty: 'error',
  })(parsed.value)
  if (Option.isNone(decoded)) {
    throw new Error('Media artifact manifest has an invalid shape')
  }
  const manifest = decoded.value
  if (
    manifest.appVersion !== expected.appVersion ||
    manifest.commitSha !== expected.commitSha ||
    manifest.electronVersion !== expected.electronVersion ||
    manifest.releaseChannel !== expected.releaseChannel
  ) {
    throw new Error('Media artifact build identity mismatch')
  }
  const hash = createHash('sha256')
    .update(readFileSync(path.join(mediaRoot, 'windows_media.node')))
    .digest('hex')
  if (manifest.files[0].sha256 !== hash) {
    throw new Error('Media artifact SHA-256 mismatch')
  }
  return manifest
}
