// Reads packages/ui primitives once and records which components own a surface:
// their source applies classes beyond placement (background, border, radius,
// padding, size, typography) or a `*Variants` recipe. Call sites must not
// restyle those; surfaceless wrappers (triggers, Squircle, ScrollArea) are free.

import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import { isPlacementClass, splitClasses } from './classes.mjs'

const CLASS_STRING = /className=["'`]([^"'`]*)["'`]|cn\(\s*["'`]([^"'`]*)["'`]/g

/** @returns {Map<string, Map<string, string>>} module → component → primitive folder */
export function loadSurfacedPrimitives(primitivesDir) {
  const modules = new Map()
  if (!existsSync(primitivesDir)) return modules
  for (const folder of readdirSync(primitivesDir)) {
    const file = join(primitivesDir, folder, 'index.tsx')
    if (!existsSync(file)) continue
    const source = readFileSync(file, 'utf8')
    const surfaced = new Map()
    const bodies = source.split(/\n(?=(?:export\s+)?function\s+[A-Z])/)
    for (const body of bodies) {
      const name = body.match(/^(?:export\s+)?function\s+([A-Z]\w*)/)?.[1]
      if (!name) continue
      if (ownsSurface(body)) surfaced.set(name, folder)
    }
    modules.set(`@syrnike13/ui/primitives/${folder}`, surfaced)
  }
  return modules
}

function ownsSurface(body) {
  if (/\b\w+Variants\(/.test(body)) return true
  for (const match of body.matchAll(CLASS_STRING)) {
    const value = match[1] ?? match[2] ?? ''
    if (splitClasses(value).some((token) => !isPlacementClass(token))) return true
  }
  return false
}
