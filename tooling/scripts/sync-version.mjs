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
  const data = readJson(relativePath)
  data.version = version
  writeJson(relativePath, data)
}

function walk(directory, matcher, files = []) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (entry.name === 'target' || entry.name === 'node_modules' || entry.name === '.git') {
      continue
    }

    const absolute = path.join(directory, entry.name)
    if (entry.isDirectory()) {
      walk(absolute, matcher, files)
    } else if (matcher(absolute)) {
      files.push(absolute)
    }
  }
  return files
}

function syncBackendCargoVersions() {
  const backendRoot = path.join(root, 'services/backend')
  const cargoFiles = [
    path.join(backendRoot, 'Cargo.toml'),
    ...walk(path.join(backendRoot, 'crates'), (file) => file.endsWith('Cargo.toml')),
  ]

  for (const file of cargoFiles) {
    let content = fs.readFileSync(file, 'utf8')
    content = content.replace(
      /(syrnike-[\w-]+\s*=\s*\{\s*version\s*=\s*")[^"]+(")/g,
      `$1${version}$2`,
    )
    content = content.replace(
      /(^version\s*=\s*")[^"]+(")/gm,
      `$1${version}$2`,
    )
    fs.writeFileSync(file, content)
  }
}

function syncGeneratedVersionFiles() {
  fs.writeFileSync(
    path.join(root, 'apps/web/src/version.gen.ts'),
    `export const APP_VERSION = '${version}'\n`,
  )

  fs.writeFileSync(
    path.join(root, 'services/backend/VERSION'),
    `${version}\n`,
  )

  fs.writeFileSync(
    path.join(root, 'services/livekit-server/APP_VERSION'),
    `${version}\n`,
  )
}

syncPackageJson('package.json')
syncPackageJson('apps/web/package.json')
syncPackageJson('apps/desktop/package.json')
syncPackageJson('packages/api-types/package.json')
syncPackageJson('packages/platform/package.json')
syncBackendCargoVersions()
syncGeneratedVersionFiles()

console.log(`[version] synced ${version}`)
