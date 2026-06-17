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
        `[desktop] music presence helper is locked by a running app; keeping ${dest}`,
      )
      return false
    }

    throw error
  }
}

const desktopRoot = resolve(import.meta.dirname, '..')
const helperRoot = resolve(desktopRoot, 'native/music-presence-win')
const publishDir = resolve(helperRoot, 'publish/win-x64')
const publishExe = resolve(publishDir, 'syrnike-music-presence-win.exe')
const outExe = resolve(
  desktopRoot,
  'out/native/syrnike-music-presence-win.exe',
)

if (process.platform !== 'win32') {
  mkdirSync(dirname(outExe), { recursive: true })
  console.info('[desktop] skipping Windows music presence helper build')
  process.exit(0)
}

mkdirSync(publishDir, { recursive: true })

const publish = spawnSync(
  'dotnet',
  [
    'publish',
    helperRoot,
    '-c',
    'Release',
    '-r',
    'win-x64',
    '--self-contained',
    'true',
    '-p:PublishAot=true',
    '-p:PublishSingleFile=true',
    '-p:DebugType=none',
    '-p:DebugSymbols=false',
    '-o',
    publishDir,
  ],
  { stdio: 'inherit' },
)

if (publish.status !== 0) {
  process.exit(publish.status ?? 1)
}

if (!existsSync(publishExe)) {
  console.error(`[desktop] music presence helper was not built: ${publishExe}`)
  process.exit(1)
}

mkdirSync(dirname(outExe), { recursive: true })

if (!shouldCopyHelper(publishExe, outExe)) {
  console.info(`[desktop] music presence helper is up to date at ${outExe}`)
  process.exit(0)
}

if (copyHelperOrWarn(publishExe, outExe)) {
  console.info(`[desktop] copied music presence helper to ${outExe}`)
}
