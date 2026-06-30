import type { LiveKitNativePublisherCredentials } from '#/features/voice/voice-join'

export function liveKitTokenExpMs(token: string) {
  const [, payload] = token.split('.')
  if (!payload) return null
  try {
    const normalized = payload.replace(/-/g, '+').replace(/_/g, '/')
    const padded = normalized.padEnd(
      normalized.length + ((4 - (normalized.length % 4)) % 4),
      '=',
    )
    const parsed = JSON.parse(globalThis.atob(padded)) as { exp?: unknown }
    return typeof parsed.exp === 'number' ? parsed.exp * 1000 : null
  } catch {
    return null
  }
}

export function shouldRefreshLiveKitToken(
  credentials: LiveKitNativePublisherCredentials,
) {
  const expMs = liveKitTokenExpMs(credentials.token)
  return expMs == null || expMs - Date.now() < 60_000
}

export function isLiveKitTokenFailure(error: unknown) {
  if (!(error instanceof Error)) return false
  const message = error.message.toLowerCase()
  return (
    message.includes('invalid token') ||
    message.includes('expired') ||
    message.includes('unauthorized') ||
    message.includes('401')
  )
}
