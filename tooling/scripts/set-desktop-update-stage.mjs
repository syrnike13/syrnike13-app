import { readdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'

const [directoryArgument, percentageArgument, ...remainingArguments] =
  process.argv.slice(2)
const allowMissing = remainingArguments.includes('--if-present')
const versionArgument = remainingArguments.find(
  (argument) => argument !== '--if-present',
)
const percentage = Number(percentageArgument)

if (!directoryArgument || ![5, 25, 50, 100].includes(percentage)) {
  throw new Error(
    'Usage: set-desktop-update-stage.mjs <release-directory> <5|25|50|100> [expected-version]',
  )
}

const directory = path.resolve(directoryArgument)
const manifests = readdirSync(directory)
  .filter((name) => /^latest.*\.ya?ml$/i.test(name))
  .map((name) => path.resolve(directory, name))

if (manifests.length === 0) {
  if (allowMissing) {
    console.info(`[desktop-release] no update manifests found in ${directory}`)
    process.exit(0)
  }
  throw new Error(`No desktop update manifests found in ${directory}`)
}

for (const manifestPath of manifests) {
  const original = readFileSync(manifestPath, 'utf8')
  const version = original.match(/^version:\s*['"]?([^'"\r\n]+)['"]?\s*$/m)?.[1]
  if (versionArgument && version !== versionArgument) {
    throw new Error(
      `${path.basename(manifestPath)} version mismatch: expected ${versionArgument}, got ${version ?? '<missing>'}`,
    )
  }
  const withoutExistingStage = original.replace(
    /^stagingPercentage:\s*\d+(?:\.\d+)?\s*\r?\n?/m,
    '',
  )
  writeFileSync(
    manifestPath,
    `${withoutExistingStage.trimEnd()}\nstagingPercentage: ${percentage}\n`,
    'utf8',
  )
  console.info(
    `[desktop-release] ${path.basename(manifestPath)} staged at ${percentage}%`,
  )
}
