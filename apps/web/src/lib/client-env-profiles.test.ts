import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { describe, expect, it } from 'vitest'

const webRoot = resolve(import.meta.dirname, '../..')

describe('client env profiles', () => {
  it('keeps Vite env files in a dedicated profile directory', () => {
    const viteConfig = readFileSync(resolve(webRoot, 'vite.config.ts'), 'utf8')

    expect(viteConfig).toContain("envDir: path.resolve(webRoot, 'env')")
  })

  it('uses an explicit local backend profile instead of root .env.local', () => {
    const packageJson = JSON.parse(
      readFileSync(resolve(webRoot, 'package.json'), 'utf8'),
    ) as { scripts: Record<string, string> }
    const localBackendEnv = resolve(webRoot, 'env/.env.localbackend')
    const localBackendSource = readFileSync(localBackendEnv, 'utf8')

    expect(existsSync(localBackendEnv)).toBe(true)
    expect(packageJson.scripts['dev:local']).toContain('--mode localbackend')
    expect(localBackendSource).toContain('VITE_API_URL=http://127.0.0.1:14702')
    expect(localBackendSource).toContain('VITE_WS_URL=ws://127.0.0.1:14703')
  })
})
