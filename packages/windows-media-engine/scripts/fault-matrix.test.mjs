import assert from 'node:assert/strict'
import { test } from 'node:test'
import { assessFaults, parseCTestCompletion } from './fault-matrix.mjs'

const expected = { commit: 'a'.repeat(40), configuration: 'Release', asan: false }
const record = () => ({
  id: 'fault-a', build: { ...expected, msvc: 195136221 },
  passed: 100, required: 100, warmup: 1, maximumIterationMs: 24,
  ownerChecksPassed: true, resourceChecksPassed: true,
  resources: { baseline: { handles: 100, threads: 5 }, final: { handles: 100, threads: 5 }, delta: { handles: 0, threads: 0 } },
})
const assess = records => assessFaults(records, expected, ['fault-a', 'fault-b'])
const complete = () => [record(), { ...record(), id: 'fault-b' }]

test('recognizes padded CTest numbers and preserves failed or skipped results', () => {
  for (const number of [' 1', '10', '100']) {
    assert.deepEqual(parseCTestCompletion(` ${number}/100 Test #${number}: owner-fault ...   Passed  0.01 sec`),
      { name: 'owner-fault', passed: true })
    for (const status of ['***Failed', '***Timeout', '***Not Run', '***Skipped']) {
      assert.deepEqual(parseCTestCompletion(` ${number}/100 Test #${number}: owner-fault ... ${status}  0.01 sec`),
        { name: 'owner-fault', passed: false })
    }
  }
  for (const line of ['      Start  1: owner-fault', '100% tests passed, 0 tests failed out of 100',
    '1: 1/100 Test # 1: owner-fault ... Passed 0.01 sec', 'unrelated output']) {
    assert.equal(parseCTestCompletion(line), undefined)
  }
})

test('accepts exactly one complete matching result for every required fault', () => {
  const result = assess(complete())
  assert.equal(result.status, 'passed')
  assert.deepEqual(result.missing, [])
  assert.deepEqual(result.violations, [])
})

test('successful processes cannot substitute for missing, duplicate or partial rows', () => {
  assert.deepEqual(assess([record()]).missing, ['fault-b'])
  assert.equal(assess([...complete(), record()]).status, 'failed')
  assert.equal(assess([{ ...record(), passed: 99 }, complete()[1]]).status, 'failed')
  assert.equal(assess([{ ...record(), ownerChecksPassed: false }, complete()[1]]).status, 'failed')
})

test('rejects stale binaries and configuration or sanitizer mismatch', () => {
  for (const build of [
    { ...expected, commit: 'b'.repeat(40) },
    { ...expected, configuration: 'Debug' },
    { ...expected, asan: true },
  ]) {
    const result = assess([{ ...record(), build: { ...build, msvc: 195136221 } }, complete()[1]])
    assert.equal(result.status, 'failed')
    assert.ok(result.violations.includes('fault-a:build-mismatch'))
  }
})

test('independently rejects positive growth and inconsistent resource deltas', () => {
  const positive = record()
  positive.resources.final.threads += 1
  positive.resources.delta.threads += 1
  assert.ok(assess([positive, complete()[1]]).violations.includes('fault-a:positive-resource-growth'))
  positive.resources.delta.threads = 0
  assert.ok(assess([positive, complete()[1]]).violations.includes('fault-a:invalid-resource-evidence'))
  assert.equal(assess([{ ...record(), resourceChecksPassed: false }, complete()[1]]).status, 'failed')
})

test('malformed evidence fails and unrecognized fields never enter the artifact', () => {
  const input = record()
  input.privateEndpoint = 'sensitive-machine-endpoint'
  input.build.machinePath = 'sensitive-machine-endpoint'
  input.resources.baseline.privatePath = 'sensitive-machine-endpoint'
  assert.ok(!JSON.stringify(assess([input, complete()[1]])).includes('sensitive-machine-endpoint'))
  for (const invalid of [null, {}, { ...record(), maximumIterationMs: Infinity }, { ...record(), resources: null }]) {
    assert.equal(assess([invalid, complete()[1]]).status, 'failed')
  }
})
