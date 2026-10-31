const fs = require('node:fs')
const path = require('node:path')

// Releases pass their version in `MOBILE_VERSION`; local builds use the repo's
// base version, like the desktop app.
const version =
  process.env.MOBILE_VERSION ||
  fs.readFileSync(path.join(__dirname, '../../VERSION'), 'utf8').trim()

/** Android needs a growing integer: 0.7.1 -> 7001, 1.2.3 -> 1002003. */
function versionCode(semver) {
  const [major, minor, patch] = semver.split('.').map((part) => Number.parseInt(part, 10))
  if (![major, minor, patch].every(Number.isInteger)) {
    throw new Error(`Mobile version must be MAJOR.MINOR.PATCH, got ${semver}`)
  }
  return major * 1_000_000 + minor * 1_000 + patch
}

/** @type {import('expo/config').ExpoConfig} */
module.exports = {
  name: 'syrnike13',
  slug: 'syrnike13',
  scheme: 'syrnike13',
  version,
  orientation: 'portrait',
  userInterfaceStyle: 'automatic',
  platforms: ['android', 'web'],
  icon: './assets/icon.png',
  // Over-the-air JS updates come from our own server (see deploy Caddyfile).
  // The fingerprint changes with any native change, so an update only reaches
  // APKs whose native code it was built against.
  runtimeVersion: { policy: 'fingerprint' },
  // The browser build replaces the web app's phone layout at `<web host>/m`.
  web: { bundler: 'metro', output: 'single', favicon: './assets/icon.png' },
  experiments: { baseUrl: '/m' },
  updates: {
    url: 'https://syrnike13.ru/downloads/mobile/manifest',
    checkAutomatically: 'ON_LOAD',
    fallbackToCacheTimeout: 0,
  },
  android: {
    package: 'ru.syrnike13.app',
    versionCode: versionCode(version),
    adaptiveIcon: {
      foregroundImage: './assets/adaptive-icon.png',
      backgroundColor: '#FFF4D6',
    },
    permissions: [
      'android.permission.RECORD_AUDIO',
      'android.permission.CAMERA',
      'android.permission.MODIFY_AUDIO_SETTINGS',
      'android.permission.BLUETOOTH_CONNECT',
      'android.permission.FOREGROUND_SERVICE_MEDIA_PROJECTION',
    ],
  },
  plugins: [
    'expo-router',
    'expo-dev-client',
    'expo-secure-store',
    '@config-plugins/react-native-webrtc',
    './modules/call-service/app.plugin.js',
    './plugins/with-release-signing.js',
    [
      'expo-build-properties',
      {
        android: {
          // LiveKit's WebRTC is reached from native code through JNI, so R8
          // must not strip or rename it in minified release builds.
          extraProguardRules: [
            '-keep class livekit.org.webrtc.** { *; }',
            '-keep class livekit.org.jni_zero.** { *; }',
            '-dontwarn livekit.org.jni_zero.**',
          ].join('\n'),
        },
      },
    ],
    [
      '@livekit/react-native-expo-plugin',
      { android: { audioType: 'communication', enableScreenShareService: true } },
    ],
    [
      'expo-splash-screen',
      {
        image: './assets/splash-icon.png',
        imageWidth: 160,
        backgroundColor: '#FFFFFF',
        dark: { backgroundColor: '#09090B' },
      },
    ],
  ],
}
