const { AndroidConfig, withAndroidManifest } = require('expo/config-plugins')

/** Lets the main activity shrink into a picture-in-picture window during calls. */
module.exports = function withCallService(config) {
  return withAndroidManifest(config, (config) => {
    const activity = AndroidConfig.Manifest.getMainActivityOrThrow(config.modResults)
    activity.$['android:supportsPictureInPicture'] = 'true'
    return config
  })
}
