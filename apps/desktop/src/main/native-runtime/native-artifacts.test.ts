import { createHash } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { verifyNativeArtifactDistribution } from './native-artifacts'

const roots: string[] = []
const binaries = [
  'livekit.dll',
  'livekit_ffi.dll',
  'syrnike_hotkey.node',
  'syrnike_overlay.node',
  'syrnike_media.node',
]
const expected = {
  appVersion: '0.5.1',
  commitSha: 'a'.repeat(40),
  contractVersion: 3,
  electronVersion: '35.7.5',
  minimumNapiVersion: 10,
  liveKitVersion: '1.3.0',
  releaseChannel: 'stable' as const,
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true })))
})

async function distribution() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'syrnike-native-artifacts-'))
  roots.push(root)
  const files = []
  for (const name of binaries) {
    const contents = Buffer.from(`binary:${name}`)
    await writeFile(path.join(root, name), contents)
    files.push({
      name,
      sha256: createHash('sha256').update(contents).digest('hex'),
    })
  }
  await writeFile(
    path.join(root, 'native-manifest.json'),
    JSON.stringify({
      schemaVersion: 1,
      contractVersion: 3,
      platform: 'win32',
      arch: 'x64',
      appVersion: '0.5.1',
      releaseChannel: 'stable',
      commitSha: 'a'.repeat(40),
      electronVersion: '35.7.5',
      napiVersion: 8,
      liveKitVersion: '1.3.0',
      files,
    }),
  )
  return root
}

describe('native artifact integrity', () => {
  it('accepts only the pinned DLL distribution', async () => {
    const root = await distribution()
    expect(verifyNativeArtifactDistribution(root, expected)).toMatchObject({
      contractVersion: 3,
      liveKitVersion: '1.3.0',
    })
  })

  it('rejects a modified native binary', async () => {
    const root = await distribution()
    await writeFile(path.join(root, 'syrnike_media.node'), 'tampered')
    expect(() => verifyNativeArtifactDistribution(root, expected)).toThrow(
      'SHA-256 mismatch',
    )
  })

  it('rejects custom runtime executables and ABI mismatches', async () => {
    const root = await distribution()
    await writeFile(path.join(root, 'legacy-helper.exe'), 'legacy')
    expect(() => verifyNativeArtifactDistribution(root, expected)).toThrow(
      'unexpected contents',
    )
    await rm(path.join(root, 'legacy-helper.exe'))
    expect(() =>
      verifyNativeArtifactDistribution(root, {
        ...expected,
        electronVersion: '36.0.0',
      }),
    ).toThrow('Electron version mismatch')
  })

  it('rejects a native distribution from a different application commit', async () => {
    const root = await distribution()
    expect(() =>
      verifyNativeArtifactDistribution(root, {
        ...expected,
        commitSha: 'b'.repeat(40),
      }),
    ).toThrow('commit mismatch')
  })
})
