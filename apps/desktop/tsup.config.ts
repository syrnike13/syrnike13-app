import { defineConfig } from 'tsup'
import { execFileSync } from 'node:child_process'
import path from 'node:path'

const WEB_DEV_URL = process.env.SYRNIKE_WEB_DEV_URL ?? 'http://127.0.0.1:3000'
const DESKTOP_RELEASE_CHANNEL =
  process.env.SYRNIKE_DESKTOP_CHANNEL === 'nightly' ? 'nightly' : 'stable'
const DESKTOP_BACKEND_MODE =
  process.env.SYRNIKE_DESKTOP_BACKEND_MODE === 'local' ? 'local' : 'release'
const DESKTOP_PUBLIC_HOST =
  DESKTOP_RELEASE_CHANNEL === 'nightly' ? 'beta.syrnike13.ru' : 'syrnike13.ru'
const DESKTOP_VOICE_WS_URL =
  process.env.SYRNIKE_DESKTOP_VOICE_WS_URL ??
  (DESKTOP_BACKEND_MODE === 'local'
    ? 'ws://127.0.0.1:14703'
    : `wss://${DESKTOP_PUBLIC_HOST}/ws`)
const DESKTOP_API_URL =
  process.env.SYRNIKE_DESKTOP_API_URL ??
  (DESKTOP_BACKEND_MODE === 'local'
    ? 'http://127.0.0.1:14702'
    : `https://${DESKTOP_PUBLIC_HOST}/api`)
const DESKTOP_SENTRY_DSN = process.env.SYRNIKE_DESKTOP_SENTRY_DSN ?? ''
const DESKTOP_SENTRY_ENVIRONMENT =
  process.env.SYRNIKE_DESKTOP_SENTRY_ENVIRONMENT ?? DESKTOP_RELEASE_CHANNEL
const DESKTOP_NATIVE_METRICS_ENDPOINT =
  process.env.SYRNIKE_DESKTOP_NATIVE_METRICS_ENDPOINT ??
  (DESKTOP_RELEASE_CHANNEL === 'nightly'
    ? 'https://beta.syrnike13.ru/api/telemetry/native'
    : 'https://syrnike13.ru/api/telemetry/native')
const DESKTOP_COMMIT_SHA =
  process.env.GITHUB_SHA ??
  execFileSync('git', ['rev-parse', 'HEAD'], {
    cwd: path.resolve(import.meta.dirname, '..', '..'),
    encoding: 'utf8',
  }).trim()

if (!/^[0-9a-f]{40}$/i.test(DESKTOP_COMMIT_SHA)) {
  throw new Error('Desktop build requires a full 40-character commit SHA')
}

const MAIN_DEFINES = {
  __DESKTOP_RELEASE_CHANNEL__: JSON.stringify(DESKTOP_RELEASE_CHANNEL),
  __DESKTOP_SENTRY_DSN__: JSON.stringify(DESKTOP_SENTRY_DSN),
  __DESKTOP_SENTRY_ENVIRONMENT__: JSON.stringify(DESKTOP_SENTRY_ENVIRONMENT),
  __DESKTOP_NATIVE_METRICS_ENDPOINT__: JSON.stringify(
    DESKTOP_NATIVE_METRICS_ENDPOINT,
  ),
  __DESKTOP_COMMIT_SHA__: JSON.stringify(DESKTOP_COMMIT_SHA),
  __DESKTOP_VOICE_WS_URL__: JSON.stringify(DESKTOP_VOICE_WS_URL),
  __DESKTOP_API_URL__: JSON.stringify(DESKTOP_API_URL),
}

export default defineConfig([
  {
    entry: ['src/main/index.ts'],
    outDir: 'out/main',
    format: ['esm'],
    platform: 'node',
    target: 'node20',
    sourcemap: true,
    clean: true,
    splitting: false,
    external: ['electron', 'electron-updater'],
    noExternal: ['@syrnike13/platform'],
    define: {
      __WEB_DEV_URL__: JSON.stringify(WEB_DEV_URL),
      ...MAIN_DEFINES,
    },
  },
  {
    entry: ['src/preload/index.ts'],
    outDir: 'out/preload',
    format: ['cjs'],
    platform: 'node',
    target: 'node20',
    sourcemap: true,
    splitting: false,
    external: ['electron', 'electron-updater'],
    noExternal: ['@syrnike13/platform'],
  },
  {
    entry: {
      'media-host': 'src/utility/media-host.ts',
      'hotkey-host': 'src/utility/hotkey-host.ts',
      'overlay-host': 'src/utility/overlay-host.ts',
    },
    outDir: 'out/utility',
    format: ['cjs'],
    platform: 'node',
    target: 'node20',
    sourcemap: true,
    clean: true,
    splitting: false,
    external: ['electron'],
    noExternal: ['@syrnike13/platform'],
    define: MAIN_DEFINES,
  },
])
