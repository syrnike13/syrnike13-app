#!/usr/bin/env node
// Ensures every locale catalog has the same keys and the same {placeholders}.

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..', '..')

export const MESSAGE_PAIRS = [
  ['apps/web/src/messages/en.json', 'apps/web/src/messages/ru.json'],
  ['apps/landing/src/messages/en.json', 'apps/landing/src/messages/ru.json'],
  ['apps/admin/src/messages/en.json', 'apps/admin/src/messages/ru.json'],
  ['apps/mobile/src/messages/en.json', 'apps/mobile/src/messages/ru.json'],
  ['packages/ui/src/i18n/messages/en.json', 'packages/ui/src/i18n/messages/ru.json'],
]

export function flattenMessages(value, prefix = '') {
  const result = new Map()

  for (const [key, entry] of Object.entries(value)) {
    const fullKey = prefix ? `${prefix}.${key}` : key
    if (entry && typeof entry === 'object' && !Array.isArray(entry)) {
      for (const [nestedKey, nestedValue] of flattenMessages(entry, fullKey)) {
        result.set(nestedKey, nestedValue)
      }
    } else {
      result.set(fullKey, entry)
    }
  }

  return result
}

export function extractPlaceholders(message) {
  const names = new Set()
  for (const match of String(message).matchAll(/\{(\w+)(?=[,}])/g)) {
    names.add(match[1])
  }
  return [...names].sort()
}

export function compareCatalogs(left, right) {
  const leftFlat = flattenMessages(left)
  const rightFlat = flattenMessages(right)
  const missingInRight = [...leftFlat.keys()].filter((key) => !rightFlat.has(key))
  const missingInLeft = [...rightFlat.keys()].filter((key) => !leftFlat.has(key))
  const placeholderMismatches = []

  for (const [key, value] of leftFlat) {
    if (!rightFlat.has(key)) continue
    const leftPlaceholders = extractPlaceholders(value).join(',')
    const rightPlaceholders = extractPlaceholders(rightFlat.get(key)).join(',')
    if (leftPlaceholders !== rightPlaceholders) {
      placeholderMismatches.push({
        key,
        left: leftPlaceholders,
        right: rightPlaceholders,
      })
    }
  }

  return { missingInRight, missingInLeft, placeholderMismatches }
}

function readJson(relativePath) {
  return JSON.parse(readFileSync(join(ROOT, relativePath), 'utf8'))
}

function main() {
  let failed = false

  for (const [leftPath, rightPath] of MESSAGE_PAIRS) {
    if (!existsSync(join(ROOT, leftPath)) || !existsSync(join(ROOT, rightPath))) {
      console.error(`check:messages: пропар каталогов не найдена: ${leftPath} / ${rightPath}`)
      failed = true
      continue
    }

    const { missingInRight, missingInLeft, placeholderMismatches } =
      compareCatalogs(readJson(leftPath), readJson(rightPath))

    if (missingInRight.length > 0) {
      failed = true
      console.error(`check:messages: ${rightPath} не хватает ключей:`)
      for (const key of missingInRight) console.error(`  - ${key}`)
    }
    if (missingInLeft.length > 0) {
      failed = true
      console.error(`check:messages: ${leftPath} не хватает ключей:`)
      for (const key of missingInLeft) console.error(`  - ${key}`)
    }
    for (const { key, left, right } of placeholderMismatches) {
      failed = true
      console.error(
        `check:messages: ${key}: плейсхолдеры не совпадают (${left || 'нет'} vs ${right || 'нет'})`,
      )
    }
  }

  if (failed) {
    console.error('check:messages: каталоги локалей расходятся.')
    return 1
  }

  console.log('check:messages: OK')
  return 0
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exitCode = main()
}
