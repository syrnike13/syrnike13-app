const DESKTOP_NATIVE_IDENTITY_SUFFIX = ':desktop-native'

export function baseVoiceIdentity(identity: string) {
  const suffixIndex = identity.indexOf(DESKTOP_NATIVE_IDENTITY_SUFFIX)
  return suffixIndex >= 0 ? identity.slice(0, suffixIndex) : identity
}

export function isDesktopNativeVoiceIdentity(identity: string) {
  return identity.includes(DESKTOP_NATIVE_IDENTITY_SUFFIX)
}
