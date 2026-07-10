import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'

const desktopRoot = path.resolve(import.meta.dirname, '..')
const repoRoot = path.resolve(desktopRoot, '..', '..')
const required = process.env.SYRNIKE_REQUIRE_SENTRY_UPLOAD === '1'
const authToken = process.env.SENTRY_AUTH_TOKEN
const organization = process.env.SENTRY_ORG
const project = process.env.SENTRY_PROJECT

if (!authToken || !organization || !project) {
  const message =
    '[desktop] Sentry debug artifact upload skipped: SENTRY_AUTH_TOKEN, SENTRY_ORG, and SENTRY_PROJECT are required'
  if (required) throw new Error(message)
  console.info(message)
  process.exit(0)
}

const version =
  process.env.SYRNIKE_DESKTOP_BUILD_VERSION ||
  readFileSync(path.resolve(repoRoot, 'VERSION'), 'utf8').trim()
const release = process.env.SENTRY_RELEASE || `syrnike13-desktop@${version}`
const nativeBuildRoot = path.resolve(
  repoRoot,
  'packages',
  'desktop-native',
  'build',
)
const sourceMapRoots = [
  path.resolve(desktopRoot, 'out', 'main'),
  path.resolve(desktopRoot, 'out', 'preload'),
  path.resolve(desktopRoot, 'out', 'utility'),
].filter(existsSync)

if (!existsSync(nativeBuildRoot)) {
  throw new Error(`Native symbol directory does not exist: ${nativeBuildRoot}`)
}

runSentry([
  'debug-files',
  'upload',
  '--org',
  organization,
  '--project',
  project,
  '--include-sources',
  nativeBuildRoot,
])

if (sourceMapRoots.length > 0) {
  runSentry(['sourcemaps', 'inject', ...sourceMapRoots])
  runSentry([
    'sourcemaps',
    'upload',
    '--org',
    organization,
    '--project',
    project,
    '--release',
    release,
    ...sourceMapRoots,
  ])
}

function runSentry(args) {
  const executable = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm'
  const result = spawnSync(executable, ['exec', 'sentry-cli', ...args], {
    cwd: desktopRoot,
    stdio: 'inherit',
    env: {
      ...process.env,
      SENTRY_AUTH_TOKEN: authToken,
    },
    shell: process.platform === 'win32',
  })
  if (result.error) throw result.error
  if (result.status !== 0) process.exit(result.status ?? 1)
}
