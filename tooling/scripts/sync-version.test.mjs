import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'

const source = fs.readFileSync(new URL('./sync-version.mjs', import.meta.url), 'utf8')

test('version sync does not rewrite backend Cargo manifests', () => {
  assert.doesNotMatch(source, /\bsyncBackendCargoVersions\s*\(\s*\)/)
  assert.doesNotMatch(source, /\bsyncBackendCargoLockVersions\s*\(\s*\)/)
})
