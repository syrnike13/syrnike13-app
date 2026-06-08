const DESKTOP_NATIVE_IDENTITY_SUFFIX = ':desktop-native'

export function baseVoiceIdentity(identity: string) {
  return identity.endsWith(DESKTOP_NATIVE_IDENTITY_SUFFIX)
    ? identity.slice(0, -DESKTOP_NATIVE_IDENTITY_SUFFIX.length)
    : identity
}

export function isDesktopNativeVoiceIdentity(identity: string) {
  return identity.endsWith(DESKTOP_NATIVE_IDENTITY_SUFFIX)
}
