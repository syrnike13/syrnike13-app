import { createHash } from 'node:crypto'
import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'

import { Option, Schema } from 'effect'

const NATIVE_BINARY_NAMES = [
  'livekit.dll',
  'livekit_ffi.dll',
  'syrnike_hotkey.node',
  'syrnike_overlay.node',
  'syrnike_media.node',
] as const

export const NATIVE_RUNTIME_LIVEKIT_VERSION = '1.3.0'

const NATIVE_DISTRIBUTION_NAMES = [
  ...NATIVE_BINARY_NAMES,
  'native-manifest.json',
].sort()

const Sha256Schema = Schema.String.check(
  Schema.isPattern(/^[0-9a-f]{64}$/i),
)

export const NativeArtifactManifestSchema = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  contractVersion: Schema.Int,
  platform: Schema.Literal('win32'),
  arch: Schema.Literal('x64'),
  appVersion: Schema.String,
  releaseChannel: Schema.Literals(['stable', 'nightly']),
  commitSha: Schema.String.check(Schema.isPattern(/^[0-9a-f]{40}$/i)),
  electronVersion: Schema.String,
  napiVersion: Schema.Int.check(Schema.isGreaterThan(0)),
  liveKitVersion: Schema.String,
  files: Schema.Array(Schema.Struct({
    name: Schema.String,
    sha256: Sha256Schema,
  })),
})
const UnknownJsonSchema = Schema.fromJsonString(Schema.Unknown)

export type NativeArtifactManifest = typeof NativeArtifactManifestSchema.Type

export type NativeArtifactExpectations = {
  appVersion: string
  commitSha: string
  contractVersion: number
  electronVersion: string
  minimumNapiVersion: number
  liveKitVersion: string
  releaseChannel: 'stable' | 'nightly'
}

export function verifyNativeArtifactDistribution(
  nativeRoot: string,
  expected: NativeArtifactExpectations,
): NativeArtifactManifest {
  if (!path.isAbsolute(nativeRoot)) {
    throw new Error('Native artifact root must be absolute')
  }

  const entries = readdirSync(nativeRoot, { withFileTypes: true })
  if (entries.some((entry) => !entry.isFile())) {
    throw new Error('Native artifact distribution contains a non-file entry')
  }
  const actualNames = entries.map((entry) => entry.name).sort()
  if (JSON.stringify(actualNames) !== JSON.stringify(NATIVE_DISTRIBUTION_NAMES)) {
    throw new Error('Native artifact distribution has unexpected contents')
  }

  const manifest = parseManifest(
    readFileSync(path.join(nativeRoot, 'native-manifest.json'), 'utf8'),
  )
  if (manifest.contractVersion !== expected.contractVersion) {
    throw new Error('Native artifact contract version mismatch')
  }
  if (manifest.appVersion !== expected.appVersion) {
    throw new Error('Native artifact application version mismatch')
  }
  if (manifest.commitSha !== expected.commitSha) {
    throw new Error('Native artifact commit mismatch')
  }
  if (manifest.releaseChannel !== expected.releaseChannel) {
    throw new Error('Native artifact release channel mismatch')
  }
  if (manifest.electronVersion !== expected.electronVersion) {
    throw new Error('Native artifact Electron version mismatch')
  }
  if (manifest.napiVersion > expected.minimumNapiVersion) {
    throw new Error('Native artifact requires a newer Node-API version')
  }
  if (manifest.liveKitVersion !== expected.liveKitVersion) {
    throw new Error('Native artifact LiveKit version mismatch')
  }

  const expectedHashes = new Map(
    manifest.files.map((file) => [file.name, file.sha256]),
  )
  if (
    expectedHashes.size !== NATIVE_BINARY_NAMES.length ||
    NATIVE_BINARY_NAMES.some((name) => !expectedHashes.has(name))
  ) {
    throw new Error('Native artifact manifest file allowlist mismatch')
  }
  for (const name of NATIVE_BINARY_NAMES) {
    const actual = createHash('sha256')
      .update(readFileSync(path.join(nativeRoot, name)))
      .digest('hex')
    if (expectedHashes.get(name) !== actual) {
      throw new Error(`Native artifact SHA-256 mismatch for ${name}`)
    }
  }
  return manifest
}

function parseManifest(value: string): NativeArtifactManifest {
  const parsed = Schema.decodeUnknownOption(UnknownJsonSchema)(value)
  if (Option.isNone(parsed)) {
    throw new Error('Native artifact manifest is not valid JSON')
  }
  const decoded = Schema.decodeUnknownOption(NativeArtifactManifestSchema)(
    parsed.value,
  )
  if (Option.isNone(decoded)) {
    throw new Error('Native artifact manifest has an invalid shape')
  }
  return decoded.value
}
