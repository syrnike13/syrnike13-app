const assert = require('node:assert/strict')
const test = require('node:test')

const {
  assertActiveHandleBound,
} = require('./microphone-resilience-runner.cjs')

test('accepts a utility process inside the fixed active handle bound', () => {
  assert.doesNotThrow(() => {
    assertActiveHandleBound({ pid: 41, handles: 640 }, 1)
  })
})

test('rejects a utility process above the fixed active handle bound', () => {
  assert.throws(
    () => assertActiveHandleBound({ pid: 41, handles: 641 }, 1),
    /epoch 1 exceeded its active handle bound: active=641, maximum=640/,
  )
})

test('rejects an invalid utility handle count', () => {
  assert.throws(
    () => assertActiveHandleBound({ pid: 41, handles: 0 }, 2),
    /epoch 2 exceeded its active handle bound/,
  )
})
