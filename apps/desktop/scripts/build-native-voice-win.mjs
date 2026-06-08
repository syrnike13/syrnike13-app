import { copyFileSync, existsSync, mkdirSync, rmSync, statSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'

function shouldCopyHelper(source, dest) {
  if (!existsSync(dest)) return true
  const sourceStat = statSync(source)
  const destStat = statSync(dest)
  return sourceStat.mtimeMs > destStat.mtimeMs || sourceStat.size !== destStat.size
}

function run(command, args) {
  const result = spawnSync(command, args, { stdio: 'inherit' })
  if (result.status !== 0) process.exit(result.status ?? 1)
}

const desktopRoot = resolve(import.meta.dirname, '..')
const helperRoot = resolve(desktopRoot, 'native/native-voice-win')
const buildDir = resolve(helperRoot, 'build')
const releaseExe = resolve(buildDir, 'Release/syrnike-native-voice-win.exe')
const outExe = resolve(desktopRoot, 'out/native/syrnike-native-voice-win.exe')
const staleCaptureExe = resolve(desktopRoot, 'out/native/syrnike-capture-helper-win.exe')
const sdkVersion = process.env.LIVEKIT_CPP_SDK_VERSION || 'v1.0.0'

if (process.platform !== 'win32') {
  mkdirSync(dirname(outExe), { recursive: true })
  console.info('[desktop] skipping Windows native voice helper build')
  process.exit(0)
}

mkdirSync(buildDir, { recursive: true })

run('cmake', [
  '-S',
  helperRoot,
  '-B',
  buildDir,
  `-DLIVEKIT_SDK_VERSION=${sdkVersion}`,
  '-A',
  'x64',
])
run('cmake', ['--build', buildDir, '--config', 'Release'])

if (!existsSync(releaseExe)) {
  console.error(`[desktop] native voice helper was not built: ${releaseExe}`)
  process.exit(1)
}

mkdirSync(dirname(outExe), { recursive: true })
if (!shouldCopyHelper(releaseExe, outExe)) {
  console.info(`[desktop] native voice helper is up to date at ${outExe}`)
} else {
  copyFileSync(releaseExe, outExe)
  console.info(`[desktop] copied native voice helper to ${outExe}`)
}

for (const dllName of ['livekit.dll', 'livekit_ffi.dll']) {
  const dllSource = resolve(
    buildDir,
    `_deps/livekit-sdk/livekit-sdk-windows-x64-${sdkVersion.replace(/^v/, '')}/bin/${dllName}`,
  )
  const dllDest = resolve(dirname(outExe), dllName)
  if (!existsSync(dllSource)) {
    console.error(`[desktop] LiveKit runtime DLL is missing: ${dllSource}`)
    process.exit(1)
  }
  copyFileSync(dllSource, dllDest)
  console.info(`[desktop] copied ${dllName} to ${dllDest}`)
}

if (existsSync(staleCaptureExe)) {
  rmSync(staleCaptureExe)
  console.info(`[desktop] removed stale Rust capture helper from ${staleCaptureExe}`)
}
