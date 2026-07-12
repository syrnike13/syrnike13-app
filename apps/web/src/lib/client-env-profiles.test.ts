import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { describe, expect, it } from 'vitest'

const webRoot = resolve(import.meta.dirname, '../..')

describe('client env profiles', () => {
  it('keeps Vite env files in a dedicated profile directory', () => {
    const viteConfig = readFileSync(resolve(webRoot, 'vite.config.ts'), 'utf8')

    expect(viteConfig).toContain("envDir: path.resolve(webRoot, 'env')")
  })

  it('uses nightly beta endpoints for default web dev', () => {
    const packageJson = JSON.parse(
      readFileSync(resolve(webRoot, 'package.json'), 'utf8'),
    ) as { scripts: Record<string, string> }
    const nightlyEnv = resolve(webRoot, 'env/.env.nightly')
    const nightlySource = readFileSync(nightlyEnv, 'utf8')

    expect(existsSync(nightlyEnv)).toBe(true)
    expect(packageJson.scripts.dev).toBe('pnpm run dev:nightly')
    expect(packageJson.scripts['dev:nightly']).toContain('--mode nightly')
    expect(nightlySource).toContain('VITE_RELEASE_CHANNEL=nightly')
    expect(nightlySource).toContain('VITE_API_URL=https://beta.syrnike13.ru/api')
    expect(nightlySource).toContain('VITE_WS_URL=wss://beta.syrnike13.ru/ws')
  })

  it('keeps an explicit local backend profile instead of root .env.local', () => {
    const packageJson = JSON.parse(
      readFileSync(resolve(webRoot, 'package.json'), 'utf8'),
    ) as { scripts: Record<string, string> }
    const localBackendEnv = resolve(webRoot, 'env/.env.localbackend')
    const localBackendSource = readFileSync(localBackendEnv, 'utf8')

    expect(existsSync(localBackendEnv)).toBe(true)
    expect(packageJson.scripts['dev:local']).toContain('--mode localbackend')
    expect(localBackendSource).toContain('VITE_RELEASE_CHANNEL=stable')
    expect(localBackendSource).toContain('VITE_API_URL=http://127.0.0.1:14702')
    expect(localBackendSource).toContain('VITE_WS_URL=ws://127.0.0.1:14703')
  })

  it('sets release channel explicitly for stable and nightly builds', () => {
    const productionEnv = readFileSync(
      resolve(webRoot, 'env/.env.production'),
      'utf8',
    )
    const dockerfile = readFileSync(resolve(webRoot, 'Dockerfile'), 'utf8')
    const root = resolve(webRoot, '../..')
    const nightlyWorkflow = readFileSync(
      resolve(root, '.github/workflows/nightly-release-and-deploy.yml'),
      'utf8',
    )
    const releaseWorkflow = readFileSync(
      resolve(root, '.github/workflows/release-images-and-deploy.yml'),
      'utf8',
    )

    expect(productionEnv).toContain('VITE_RELEASE_CHANNEL=stable')
    expect(dockerfile).toContain('ARG VITE_RELEASE_CHANNEL=stable')
    expect(nightlyWorkflow).toContain('VITE_RELEASE_CHANNEL=nightly')
    expect(releaseWorkflow).toContain('VITE_RELEASE_CHANNEL=stable')
  })
})
