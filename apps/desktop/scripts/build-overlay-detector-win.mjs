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
    if (error && typeof error === 'object' && 'code' in error && error.code === 'EBUSY' && existsSync(dest)) {
      console.warn(
        `[desktop] overlay detector is locked by a running app; keeping ${dest}`,
      )
      return false
    }

    throw error
  }
}

const desktopRoot = resolve(import.meta.dirname, '..')
const helperRoot = resolve(desktopRoot, 'native/overlay-detector-win')
const buildDir = resolve(helperRoot, 'build')
const releaseExe = resolve(buildDir, 'Release/syrnike-overlay-detector-win.exe')
const outExe = resolve(
  desktopRoot,
  'out/native/syrnike-overlay-detector-win.exe',
)

if (process.platform !== 'win32') {
  mkdirSync(dirname(outExe), { recursive: true })
  console.info('[desktop] skipping Windows overlay detector build')
  process.exit(0)
}

mkdirSync(buildDir, { recursive: true })

const configure = spawnSync('cmake', ['-S', helperRoot, '-B', buildDir, '-A', 'x64'], {
  stdio: 'inherit',
})

if (configure.status !== 0) {
  process.exit(configure.status ?? 1)
}

const result = spawnSync('cmake', ['--build', buildDir, '--config', 'Release'], {
  stdio: 'inherit',
})

if (result.status !== 0) {
  process.exit(result.status ?? 1)
}

if (!existsSync(releaseExe)) {
  console.error(`[desktop] overlay detector was not built: ${releaseExe}`)
  process.exit(1)
}

mkdirSync(dirname(outExe), { recursive: true })

if (!shouldCopyHelper(releaseExe, outExe)) {
  console.info(`[desktop] overlay detector is up to date at ${outExe}`)
  process.exit(0)
}

if (copyHelperOrWarn(releaseExe, outExe)) {
  console.info(`[desktop] copied overlay detector to ${outExe}`)
}
