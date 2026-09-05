import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { verifyNativeArtifactDistribution } from './native-artifacts'
import { NATIVE_RUNTIME_CONTRACT_VERSION } from './contract'

const roots: string[] = []
const binaries = [
  'syrnike_hotkey.node',
  'syrnike_overlay.node',
]
const expected = {
  appVersion: '0.5.1',
  commitSha: 'a'.repeat(40),
  contractVersion: 6,
  electronVersion: '35.7.5',
  minimumNapiVersion: 10,
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
      contractVersion: 6,
      platform: 'win32',
      arch: 'x64',
      appVersion: '0.5.1',
      releaseChannel: 'stable',
      commitSha: 'a'.repeat(40),
      electronVersion: '35.7.5',
      napiVersion: 8,
      capabilities: ['hotkeys', 'overlay'],
      files,
    }),
  )
  return root
}

describe('native artifact integrity', () => {
  it('keeps TypeScript, native addon, build, and verifier contract versions aligned', async () => {
    const repositoryRoot = path.resolve(import.meta.dirname, '../../../../..')
    const [nativeHeader, buildScript, verifyScript] = await Promise.all([
      readFile(path.join(
        repositoryRoot,
        'packages/desktop-native/native/src/common/native_contract_version.hpp',
      ), 'utf8'),
      readFile(path.join(
        repositoryRoot,
        'packages/desktop-native/scripts/build.mjs',
      ), 'utf8'),
      readFile(path.join(
        repositoryRoot,
        'packages/desktop-native/scripts/verify-artifacts.mjs',
      ), 'utf8'),
    ])
    expect(nativeHeader).toContain(
      `kNativeRuntimeContractVersion = ${NATIVE_RUNTIME_CONTRACT_VERSION}`,
    )
    expect(buildScript).toContain(
      `CONTRACT_VERSION = ${NATIVE_RUNTIME_CONTRACT_VERSION}`,
    )
    expect(verifyScript).toContain(
      `manifest.contractVersion !== ${NATIVE_RUNTIME_CONTRACT_VERSION}`,
    )
  })

  it('accepts only the pinned hook-addon distribution', async () => {
    const root = await distribution()
    expect(verifyNativeArtifactDistribution(root, expected)).toMatchObject({
      contractVersion: 6,
      capabilities: ['hotkeys', 'overlay'],
    })
  })

  it('rejects a modified native binary', async () => {
    const root = await distribution()
    await writeFile(path.join(root, 'syrnike_hotkey.node'), 'tampered')
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
