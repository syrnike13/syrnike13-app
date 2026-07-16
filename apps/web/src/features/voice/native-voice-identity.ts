const VOICE_IDENTITY_PREFIX = 'voice:v1|'

export type ParsedVoiceIdentity = Readonly<{
  rtcEngine: 'web' | 'windows_native'
  clientInstanceId: string
  connectionEpoch: string
  operationId: string
  userId: string
}>

export function parseVoiceIdentity(identity: string): ParsedVoiceIdentity | null {
  if (!identity.startsWith(VOICE_IDENTITY_PREFIX)) return null
  const parts = identity.split('|')
  if (parts.length !== 6 || parts[0] !== 'voice:v1') return null
  const rtcEngine = parts[1]
  if (rtcEngine !== 'web' && rtcEngine !== 'windows_native') return null
  const [clientInstanceId, connectionEpoch, operationId, userId] = parts.slice(2)
  if (!clientInstanceId || !connectionEpoch || !operationId || !userId) return null
  return {
    rtcEngine,
    clientInstanceId,
    connectionEpoch,
    operationId,
    userId,
  }
}

export function baseVoiceIdentity(identity: string) {
  return parseVoiceIdentity(identity)?.userId ?? identity
}

export function isDesktopNativeVoiceIdentity(identity: string) {
  return parseVoiceIdentity(identity)?.rtcEngine === 'windows_native'
}
