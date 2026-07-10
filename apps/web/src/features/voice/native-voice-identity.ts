const DESKTOP_NATIVE_IDENTITY_SUFFIX = ':desktop-native'
const BROWSER_VOICE_IDENTITY_SUFFIX = ':browser'

export function baseVoiceIdentity(identity: string) {
  const suffixIndex = [
    identity.indexOf(DESKTOP_NATIVE_IDENTITY_SUFFIX),
    identity.indexOf(BROWSER_VOICE_IDENTITY_SUFFIX),
  ]
    .filter((index) => index >= 0)
    .reduce((lowest, index) => Math.min(lowest, index), identity.length)
  return suffixIndex >= 0 ? identity.slice(0, suffixIndex) : identity
}

export function isDesktopNativeVoiceIdentity(identity: string) {
  return identity.includes(DESKTOP_NATIVE_IDENTITY_SUFFIX)
}
