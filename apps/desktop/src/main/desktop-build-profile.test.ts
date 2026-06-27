import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { describe, expect, it } from 'vitest'

const desktopRoot = resolve(import.meta.dirname, '../..')

describe('desktop production build profile', () => {
  it('verifies packaged web assets cannot contain local backend URLs', () => {
    const packageJson = JSON.parse(
      readFileSync(resolve(desktopRoot, 'package.json'), 'utf8'),
    ) as { scripts: Record<string, string> }
    const verifierPath = resolve(
      desktopRoot,
      'scripts/verify-web-dist-production.mjs',
    )

    expect(existsSync(verifierPath)).toBe(true)
    expect(packageJson.scripts.build).toContain('verify:web-dist')
    expect(packageJson.scripts.package).toContain('pnpm run build')
  })
})
