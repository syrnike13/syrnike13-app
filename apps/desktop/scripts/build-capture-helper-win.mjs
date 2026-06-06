import { copyFileSync, existsSync, mkdirSync, statSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'

function shouldCopyHelper(source, dest) {
  if (!existsSync(dest)) return true

  const sourceStat = statSync(source)
  const destStat = statSync(dest)

  return (
    sourceStat.mtimeMs > destStat.mtimeMs ||
    sourceStat.size !== destStat.size
  )
}

function copyHelperOrWarn(source, dest) {
  try {
    copyFileSync(source, dest)
    return true
  } catch (error) {
    if (
      error &&
      typeof error === 'object' &&
      'code' in error &&
      error.code === 'EBUSY' &&
      existsSync(dest)
    ) {
      console.warn(
        `[desktop] capture helper is locked by a running app; keeping ${dest}`,
      )
      return false
    }

    throw error
  }
}

const desktopRoot = resolve(import.meta.dirname, '..')
const helperRoot = resolve(desktopRoot, 'native/capture-helper-win')
const releaseExe = resolve(
  helperRoot,
  'target/release/syrnike-capture-helper-win.exe',
)
const outExe = resolve(
  desktopRoot,
  'out/native/syrnike-capture-helper-win.exe',
)

if (process.platform !== 'win32') {
  mkdirSync(dirname(outExe), { recursive: true })
  console.info('[desktop] skipping Windows capture helper build')
  process.exit(0)
}

const result = spawnSync(
  'cargo',
  ['build', '--release', '--manifest-path', resolve(helperRoot, 'Cargo.toml')],
  {
    stdio: 'inherit',
  },
)

if (result.status !== 0) {
  process.exit(result.status ?? 1)
}

if (!existsSync(releaseExe)) {
  console.error(`[desktop] capture helper was not built: ${releaseExe}`)
  process.exit(1)
}

mkdirSync(dirname(outExe), { recursive: true })

if (!shouldCopyHelper(releaseExe, outExe)) {
  console.info(`[desktop] capture helper is up to date at ${outExe}`)
  process.exit(0)
}

if (copyHelperOrWarn(releaseExe, outExe)) {
  console.info(`[desktop] copied capture helper to ${outExe}`)
}
