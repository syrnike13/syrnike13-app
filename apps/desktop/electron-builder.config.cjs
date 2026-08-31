const { createHash } = require('node:crypto')
const { readFileSync, writeFileSync } = require('node:fs')
const path = require('node:path')

const isNightly = process.env.SYRNIKE_DESKTOP_CHANNEL === 'nightly'

const productName = isNightly ? 'syrnike13 Nightly' : 'syrnike13'
const appId = isNightly
  ? 'ru.syrnike13.desktop.nightly'
  : 'ru.syrnike13.desktop'
const protocolScheme = isNightly ? 'syrnike13-nightly' : 'syrnike13'
const buildVersion = process.env.SYRNIKE_DESKTOP_BUILD_VERSION
const requireWindowsSigning =
  process.env.SYRNIKE_REQUIRE_WINDOWS_SIGNING === '1'
const azureSigning = {
  publisherName: process.env.SYRNIKE_AZURE_SIGN_PUBLISHER,
  endpoint: process.env.SYRNIKE_AZURE_SIGN_ENDPOINT,
  certificateProfileName: process.env.SYRNIKE_AZURE_SIGN_CERTIFICATE_PROFILE,
  codeSigningAccountName: process.env.SYRNIKE_AZURE_SIGN_ACCOUNT,
}
const configuredAzureSigningFields = Object.entries(azureSigning).filter(
  ([, value]) => Boolean(value),
)
const missingAzureSigningFields = Object.entries(azureSigning)
  .filter(([, value]) => !value)
  .map(([name]) => name)

if (configuredAzureSigningFields.length > 0 && missingAzureSigningFields.length > 0) {
  throw new Error(
    `Incomplete Azure Trusted Signing configuration: ${missingAzureSigningFields.join(', ')}`,
  )
}
if (requireWindowsSigning && missingAzureSigningFields.length > 0) {
  throw new Error(
    `Stable Windows signing is required but Azure configuration is missing: ${missingAzureSigningFields.join(', ')}`,
  )
}

const nativeFiles = [
  'syrnike_hotkey.node',
  'syrnike_overlay.node',
  'native-manifest.json',
]
const mediaFiles = [
  'windows_media.node', 'livekit.dll', 'livekit_ffi.dll', 'media-manifest.json',
]

function refreshManifest(root, manifestName, files) {
  const manifestPath = path.join(root, manifestName)
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  manifest.files = files
    .filter((name) => name !== manifestName)
    .map((name) => ({
      name,
      sha256: createHash('sha256')
        .update(readFileSync(path.join(root, name)))
        .digest('hex'),
    }))
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
}

function refreshPackagedNativeManifests(context) {
  if (context.electronPlatformName !== 'win32') return
  refreshManifest(
    path.join(context.appOutDir, 'resources', 'native', 'win32-x64'),
    'native-manifest.json',
    nativeFiles,
  )
  refreshManifest(
    path.join(context.appOutDir, 'resources', 'media-engine', 'win32-x64'),
    'media-manifest.json',
    mediaFiles,
  )
}

/** @type {import('electron-builder').Configuration} */
module.exports = {
  appId,
  productName,
  protocols: [
    {
      name: protocolScheme,
      schemes: [protocolScheme],
    },
  ],
  directories: {
    output: isNightly ? 'release-nightly' : 'release',
  },
  files: [
    'out/**/*',
    '!out/native/**',
    '!out/media-native/**',
    '!out/**/*.map',
    'package.json',
  ],
  extraMetadata: {
    name: isNightly ? 'syrnike13-nightly' : '@syrnike13/desktop',
    productName,
    ...(buildVersion ? { version: buildVersion } : {}),
    syrnike13: {
      releaseChannel: isNightly ? 'nightly' : 'stable',
    },
  },
  extraResources: [
    {
      from: 'assets',
      to: 'assets',
      filter: ['**/*'],
    },
    {
      from: '../web/dist',
      to: 'web-dist',
      filter: ['**/*'],
    },
    ...(process.platform === 'win32'
      ? [
          {
            from: 'out/native/win32-x64',
            to: 'native/win32-x64',
            filter: nativeFiles,
          },
          {
            from: 'out/media-native/win32-x64',
            to: 'media-engine/win32-x64',
            filter: mediaFiles,
          },
        ]
      : []),
  ],
  // afterPack covers unsigned/nightly packages. afterSign refreshes hashes after
  // Authenticode has changed the signed binary bytes and before NSIS is built.
  afterPack: refreshPackagedNativeManifests,
  afterSign: refreshPackagedNativeManifests,
  mac: {
    category: 'public.app-category.social-networking',
    target: ['dmg', 'zip'],
  },
  win: {
    icon: 'assets/app.ico',
    target: ['nsis'],
    signExts: ['.node'],
    forceCodeSigning: requireWindowsSigning,
    ...(missingAzureSigningFields.length === 0
      ? { azureSignOptions: azureSigning }
      : {}),
  },
  linux: {
    target: ['AppImage'],
  },
  ...(isNightly
    ? {}
    : {
        publish: {
          provider: 'generic',
          url: 'https://syrnike13.ru/downloads/desktop/',
        },
      }),
  nsis: {
    differentialPackage: true,
  },
}
