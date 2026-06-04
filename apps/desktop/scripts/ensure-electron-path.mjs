import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const electronDir = path.dirname(require.resolve('electron/package.json'))
const pathFile = path.join(electronDir, 'path.txt')
const distDir = path.join(electronDir, 'dist')

function electronDistReady() {
  if (!fs.existsSync(path.join(distDir, 'version'))) return false

  if (process.platform === 'darwin') {
    return fs.existsSync(
      path.join(
        distDir,
        'Electron.app/Contents/Frameworks/Electron Framework.framework',
      ),
    )
  }

  if (process.platform === 'win32') {
    return fs.existsSync(path.join(distDir, 'electron.exe'))
  }

  return fs.existsSync(path.join(distDir, 'electron'))
}

function repairPathTxt() {
  const platformPath =
    process.platform === 'darwin'
      ? 'Electron.app/Contents/MacOS/Electron'
      : process.platform === 'win32'
        ? 'electron.exe'
        : 'electron'

  const current = fs.existsSync(pathFile)
    ? fs.readFileSync(pathFile, 'utf8')
    : ''

  if (current !== platformPath) {
    fs.writeFileSync(pathFile, platformPath, 'utf8')
    console.info('[desktop] repaired electron path.txt')
  }
}

if (!electronDistReady()) {
  console.info('[desktop] Electron binary incomplete — running install.js…')
  const result = spawnSync(process.execPath, ['install.js'], {
    cwd: electronDir,
    stdio: 'inherit',
    env: { ...process.env, ELECTRON_SKIP_BINARY_DOWNLOAD: '' },
  })

  if (result.status !== 0) {
    console.error(
      '[desktop] Electron install failed. Try: pnpm rebuild electron',
    )
    process.exit(result.status ?? 1)
  }
}

if (!electronDistReady()) {
  console.error(
    '[desktop] Electron is still missing after install. Run from repo root:\n' +
      '  pnpm rebuild electron',
  )
  process.exit(1)
}

repairPathTxt()
