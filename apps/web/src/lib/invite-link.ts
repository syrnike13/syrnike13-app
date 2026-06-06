import { publicAppUrl } from './public-origin'

export function inviteUrl(code: string) {
  return publicAppUrl(`/invite/${code}`)
}

const INVITE_CODE_REGEX = /^[\w-]+$/i

/** Из полной ссылки или голого кода — id приглашения для `/invite/$code`. */
export function parseInviteCode(input: string): string | null {
  const trimmed = input.trim()
  if (!trimmed) return null

  if (trimmed.includes('/')) {
    try {
      const url = new URL(
        trimmed,
        typeof window !== 'undefined' ? window.location.origin : 'https://localhost',
      )
      if (url.protocol === 'syrnike13:' && url.hostname === 'invite') {
        const code = url.pathname.replace(/^\/+/, '')
        return INVITE_CODE_REGEX.test(code) ? code : null
      }

      const match = url.pathname.match(/\/invite\/([^/?#]+)/)
      if (match?.[1]) {
        const decoded = decodeURIComponent(match[1])
        return INVITE_CODE_REGEX.test(decoded) ? decoded : null
      }
    } catch {
      return null
    }
  }

  return INVITE_CODE_REGEX.test(trimmed) ? trimmed : null
}
