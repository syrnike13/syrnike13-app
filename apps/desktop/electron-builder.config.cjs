const isNightly = process.env.SYRNIKE_DESKTOP_CHANNEL === 'nightly'

const productName = isNightly ? 'syrnike13 Nightly' : 'syrnike13'
const appId = isNightly
  ? 'ru.syrnike13.desktop.nightly'
  : 'ru.syrnike13.desktop'
const protocolScheme = isNightly ? 'syrnike13-nightly' : 'syrnike13'
const buildVersion = process.env.SYRNIKE_DESKTOP_BUILD_VERSION

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
  files: ['out/**/*', 'package.json'],
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
    {
      from: 'out/native',
      to: 'native',
      filter: ['**/*'],
    },
  ],
  mac: {
    category: 'public.app-category.social-networking',
    target: ['dmg', 'zip'],
  },
  win: {
    icon: 'assets/app.ico',
    target: ['nsis'],
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
