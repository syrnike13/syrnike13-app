import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { buildMobileUpdate } from './build-mobile-update.mjs'

function exportFixture() {
  const dir = mkdtempSync(join(tmpdir(), 'mobile-update-'))
  mkdirSync(join(dir, '_expo/static/js/android'), { recursive: true })
  mkdirSync(join(dir, 'assets'))
  writeFileSync(join(dir, '_expo/static/js/android/index-abc.hbc'), 'bundle')
  writeFileSync(join(dir, 'assets/5f3a'), 'image')
  writeFileSync(
    join(dir, 'metadata.json'),
    JSON.stringify({
      version: 0,
      bundler: 'metro',
      fileMetadata: {
        android: {
          bundle: '_expo/static/js/android/index-abc.hbc',
          assets: [{ path: 'assets/5f3a', ext: 'png' }],
        },
      },
    }),
  )
  return dir
}

const options = (exportDir) => ({
  exportDir,
  expoConfig: { name: 'syrnike13' },
  runtimeVersion: 'abc123',
  baseUrl: 'https://example.test/downloads/mobile',
  createdAt: '2026-10-31T00:00:00.000Z',
  id: '00000000-0000-4000-8000-000000000000',
})

test('describes the bundle and assets as content-addressed protocol v1 assets', () => {
  const { manifest, files } = buildMobileUpdate(options(exportFixture()))
  const bundleHash = createHash('sha256').update('bundle').digest()

  assert.deepEqual(manifest.launchAsset, {
    hash: bundleHash.toString('base64url'),
    key: createHash('md5').update('bundle').digest('hex'),
    contentType: 'application/javascript',
    url: `https://example.test/downloads/mobile/assets/${bundleHash.toString('hex')}.hbc`,
  })
  assert.equal(manifest.assets[0].contentType, 'image/png')
  assert.equal(manifest.assets[0].fileExtension, '.png')
  assert.equal(manifest.runtimeVersion, 'abc123')
  assert.deepEqual(manifest.extra, { expoClient: { name: 'syrnike13' } })
  assert.equal(files.length, 2)
})

test('rejects runtime versions that are not plain path tokens', () => {
  assert.throws(
    () => buildMobileUpdate({ ...options(exportFixture()), runtimeVersion: '../x' }),
    /Unsafe runtime version/,
  )
})
