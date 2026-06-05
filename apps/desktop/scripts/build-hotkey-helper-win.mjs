import { copyFileSync, existsSync, mkdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'

const desktopRoot = resolve(import.meta.dirname, '..')
const helperRoot = resolve(desktopRoot, 'native/hotkey-helper-win')
const releaseExe = resolve(
  helperRoot,
  'target/release/syrnike-hotkey-helper-win.exe',
)
const outExe = resolve(
  desktopRoot,
  'out/native/syrnike-hotkey-helper-win.exe',
)

if (process.platform !== 'win32') {
  mkdirSync(dirname(outExe), { recursive: true })
  console.info('[desktop] skipping Windows hotkey helper build')
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
  console.error(`[desktop] hotkey helper was not built: ${releaseExe}`)
  process.exit(1)
}

mkdirSync(dirname(outExe), { recursive: true })
copyFileSync(releaseExe, outExe)
console.info(`[desktop] copied hotkey helper to ${outExe}`)
