import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

import {
  MESSAGE_PAIRS,
  compareCatalogs,
  extractPlaceholders,
  flattenMessages,
} from './check-messages.mjs'

const root = new URL('../../', import.meta.url)

test('flattens nested message catalogs', () => {
  const flat = flattenMessages({ a: { b: 'B', c: { d: 'D' } }, e: 'E' })
  assert.deepEqual([...flat.entries()], [
    ['a.b', 'B'],
    ['a.c.d', 'D'],
    ['e', 'E'],
  ])
})

test('extracts placeholders and ignores plural syntax', () => {
  assert.deepEqual(
    extractPlaceholders('Привет, {name}. {count, plural, one {# файл} other {# файла}}'),
    ['count', 'name'],
  )
})

test('reports missing keys and placeholder mismatches', () => {
  const result = compareCatalogs(
    { a: 'A {name}', b: 'B' },
    { a: 'A {user}', c: 'C' },
  )

  assert.deepEqual(result.missingInRight, ['b'])
  assert.deepEqual(result.missingInLeft, ['c'])
  assert.deepEqual(result.placeholderMismatches, [
    { key: 'a', left: 'name', right: 'user' },
  ])
})

test('package locale catalogs are in sync', () => {
  for (const [leftPath, rightPath] of MESSAGE_PAIRS) {
    const left = JSON.parse(readFileSync(new URL(leftPath, root), 'utf8'))
    const right = JSON.parse(readFileSync(new URL(rightPath, root), 'utf8'))
    assert.deepEqual(compareCatalogs(left, right), {
      missingInRight: [],
      missingInLeft: [],
      placeholderMismatches: [],
    })
  }
})
