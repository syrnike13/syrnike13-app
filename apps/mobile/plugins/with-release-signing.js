const { withAppBuildGradle } = require('expo/config-plugins')

/**
 * Signs release builds with the upload keystore when CI provides it through
 * `SYRNIKE_ANDROID_KEYSTORE` (path), `SYRNIKE_ANDROID_KEYSTORE_PASSWORD`,
 * `SYRNIKE_ANDROID_KEY_ALIAS` and `SYRNIKE_ANDROID_KEY_PASSWORD`. Without them a
 * local release build keeps Expo's debug signing.
 *
 * APKs installed from the site update in place only while every release is
 * signed with the same key: losing it means users must reinstall.
 */
module.exports = function withReleaseSigning(config) {
  return withAppBuildGradle(config, (config) => {
    const gradle = config.modResults.contents
    if (gradle.includes('signingConfigs.syrnikeRelease')) return config

    config.modResults.contents = gradle
      .replace(
        /signingConfigs \{\n/,
        `signingConfigs {
        if (System.getenv('SYRNIKE_ANDROID_KEYSTORE')) {
            syrnikeRelease {
                storeFile file(System.getenv('SYRNIKE_ANDROID_KEYSTORE'))
                storePassword System.getenv('SYRNIKE_ANDROID_KEYSTORE_PASSWORD')
                keyAlias System.getenv('SYRNIKE_ANDROID_KEY_ALIAS')
                keyPassword System.getenv('SYRNIKE_ANDROID_KEY_PASSWORD')
            }
        }
`,
      )
      .replace(
        /(release \{[^}]*?)signingConfig signingConfigs\.debug/,
        `$1signingConfig System.getenv('SYRNIKE_ANDROID_KEYSTORE') ? signingConfigs.syrnikeRelease : signingConfigs.debug`,
      )
    return config
  })
}
