import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'

const source = fs.readFileSync(
  new URL('../../.github/workflows/pr-ready-checks.yml', import.meta.url),
  'utf8',
)

test('ready PR workflow runs frontend checks for non-draft pull requests', () => {
  assert.match(source, /ready_for_review/)
  assert.match(source, /github\.event\.pull_request\.draft == false/)
  assert.match(source, /pnpm web:test/)
  assert.match(source, /pnpm web:build/)
})

test('ready PR workflow runs backend checks for non-draft pull requests', () => {
  assert.match(source, /services\/backend\/rust-toolchain\.toml/)
  assert.match(source, /pnpm backend:check/)
})
