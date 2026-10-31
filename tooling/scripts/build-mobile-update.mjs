#!/usr/bin/env node
// Turns `expo export --platform android` output into a static Expo Updates
// (protocol v1) release: content-addressed files under `assets/` and the
// manifest under `updates/<runtimeVersion>/manifest.json`. Caddy serves the
// manifest for the runtime version the app sends (see deploy Caddyfile).
//
// Usage: build-mobile-update.mjs <export-dir> <expo-config.json> <runtime-version> <base-url> <out-dir>

import { createHash, randomUUID } from 'node:crypto'
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { extname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const CONTENT_TYPES = {
  hbc: 'application/javascript',
  js: 'application/javascript',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  svg: 'image/svg+xml',
  ttf: 'font/ttf',
  otf: 'font/otf',
  json: 'application/json',
}

/** Runtime versions become URL paths, so only plain tokens are allowed. */
export const RUNTIME_VERSION = /^[A-Za-z0-9._-]+$/

/**
 * One manifest asset. `hash` is the Base64URL SHA-256 the client verifies;
 * `key` is the MD5 Metro uses to reference the asset from the bundle.
 */
export function describeAsset(bytes, ext, baseUrl, isLaunchAsset) {
  const sha256 = createHash('sha256').update(bytes).digest()
  const file = `${sha256.toString('hex')}.${ext}`
  return {
    file,
    asset: {
      hash: sha256.toString('base64url'),
      key: createHash('md5').update(bytes).digest('hex'),
      contentType: CONTENT_TYPES[ext] ?? 'application/octet-stream',
      ...(isLaunchAsset ? {} : { fileExtension: `.${ext}` }),
      url: `${baseUrl}/assets/${file}`,
    },
  }
}

export function buildMobileUpdate({ exportDir, expoConfig, runtimeVersion, baseUrl, createdAt, id }) {
  if (!RUNTIME_VERSION.test(runtimeVersion)) {
    throw new Error(`Unsafe runtime version: ${runtimeVersion}`)
  }
  const metadata = JSON.parse(readFileSync(join(exportDir, 'metadata.json'), 'utf8'))
  const android = metadata.fileMetadata?.android
  if (!android?.bundle) throw new Error('The export has no Android bundle')

  const files = []
  const describe = (path, ext, isLaunchAsset) => {
    const source = join(exportDir, path)
    const { file, asset } = describeAsset(readFileSync(source), ext, baseUrl, isLaunchAsset)
    files.push({ source, file })
    return asset
  }

  const manifest = {
    id,
    createdAt,
    runtimeVersion,
    launchAsset: describe(android.bundle, extname(android.bundle).slice(1), true),
    assets: android.assets.map((asset) => describe(asset.path, asset.ext, false)),
    metadata: {},
    // `Constants.expoConfig` in the running app comes from here.
    extra: { expoClient: expoConfig },
  }
  return { manifest, files }
}

function main([exportDir, expoConfigPath, runtimeVersion, baseUrl, outDir]) {
  if (!outDir) {
    throw new Error(
      'Usage: build-mobile-update.mjs <export-dir> <expo-config.json> <runtime-version> <base-url> <out-dir>',
    )
  }
  const { manifest, files } = buildMobileUpdate({
    exportDir,
    expoConfig: JSON.parse(readFileSync(expoConfigPath, 'utf8')),
    runtimeVersion,
    baseUrl: baseUrl.replace(/\/$/, ''),
    createdAt: new Date().toISOString(),
    id: randomUUID(),
  })

  mkdirSync(join(outDir, 'assets'), { recursive: true })
  for (const { source, file } of files) copyFileSync(source, join(outDir, 'assets', file))
  const manifestDir = join(outDir, 'updates', runtimeVersion)
  mkdirSync(manifestDir, { recursive: true })
  writeFileSync(join(manifestDir, 'manifest.json'), `${JSON.stringify(manifest)}\n`)
  console.log(`Update ${manifest.id} for runtime ${runtimeVersion}: ${files.length} file(s)`)
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main(process.argv.slice(2))
