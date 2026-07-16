import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const version = fs.readFileSync(path.join(root, 'VERSION'), 'utf8').trim()

if (!/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(version)) {
  throw new Error(`VERSION must be a semver string, got "${version}"`)
}

function readJson(relativePath) {
  return JSON.parse(fs.readFileSync(path.join(root, relativePath), 'utf8'))
}

function writeJson(relativePath, value) {
  fs.writeFileSync(
    path.join(root, relativePath),
    `${JSON.stringify(value, null, 2)}\n`,
  )
}

function syncPackageJson(relativePath) {
  if (!fs.existsSync(path.join(root, relativePath))) {
    return
  }

  const data = readJson(relativePath)
  data.version = version
  writeJson(relativePath, data)
}

function syncGeneratedVersionFiles() {
  const files = [
    ['apps/web/src/version.gen.ts', `export const APP_VERSION = '${version}'\n`],
    ['apps/admin/src/version.gen.ts', `export const APP_VERSION = '${version}'\n`],
    ['services/backend/VERSION', `${version}\n`],
    ['services/livekit-server/APP_VERSION', `${version}\n`],
  ]

  for (const [relativePath, content] of files) {
    const absolutePath = path.join(root, relativePath)
    if (fs.existsSync(path.dirname(absolutePath))) {
      fs.writeFileSync(absolutePath, content)
    }
  }
}

syncPackageJson('package.json')
syncPackageJson('apps/web/package.json')
syncPackageJson('apps/admin/package.json')
syncPackageJson('apps/desktop/package.json')
syncPackageJson('packages/api-types/package.json')
syncPackageJson('packages/desktop-native/package.json')
syncPackageJson('packages/platform/package.json')
syncGeneratedVersionFiles()

console.log(`[version] synced ${version}`)
