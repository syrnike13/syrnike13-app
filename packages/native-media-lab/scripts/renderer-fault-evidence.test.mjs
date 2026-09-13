import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createRendererFaultEvidence } from './renderer-fault-evidence.mjs'

function run(change = () => {}) {
  const evidence = createRendererFaultEvidence()
  const publications = ['microphone', 'screen', 'screen_audio', 'camera'].map(source =>
    ({ source, alias: source, frames: 10, unsubscribed: false }))
  for (const id of ['renderer-reload', 'renderer-crash', 'renderer-release-stall']) {
    evidence.record({ id, event: 'begin' }, publications)
    for (let iteration = 0; iteration < 100; ++iteration) {
      for (const value of publications) value.frames += 10
      evidence.observeGap(100)
      change({ evidence, publications, id, iteration })
      evidence.record({ id, event: 'completed', iteration, elapsedMs: 350 }, publications)
    }
  }
  return evidence.result()
}

test('accepts 100 reloads, crashes and release stalls only with progress on all unchanged publications', () => {
  const result = run()
  assert.equal(result.passed, true)
  assert.equal(result.rows.length, 3)
  for (const row of result.rows) {
    assert.equal(row.passed, 100)
    assert.equal(row.minimumFrameProgress, 10)
    assert.equal(row.maximumReceiverGapMs, 100)
  }
})

test('rejects one stalled, replaced, missing or duplicated publication', () => {
  for (const change of [
    publications => { publications[0].frames -= 10 },
    publications => { publications[1].alias = 'replacement' },
    publications => { publications[2].unsubscribed = true },
    publications => { publications.push({ ...publications[3] }) },
  ]) {
    assert.equal(run(({ publications, id, iteration }) => {
      if (id === 'renderer-crash' && iteration === 50) change(publications)
    }).passed, false)
  }
})

test('rejects a receiver gap even when subsequent frames catch up', () => {
  const result = run(({ evidence, id, iteration }) => {
    if (id === 'renderer-reload' && iteration === 20) evidence.observeGap(1501)
  })
  assert.equal(result.passed, false)
  assert.equal(result.rows[0].maximumReceiverGapMs, 1501)
})

test('missing, duplicate and out-of-order evidence cannot qualify', () => {
  assert.equal(createRendererFaultEvidence().result().passed, false)
  for (const event of [null, { id: 'renderer-crash', event: 'begin' },
    { id: 'renderer-reload', event: 'completed', iteration: 99, elapsedMs: 300 }]) {
    const result = run(({ evidence, publications, id, iteration }) => {
      if (id === 'renderer-reload' && iteration === 20) evidence.record(event, publications)
    })
    assert.equal(result.passed, false)
  }
})
