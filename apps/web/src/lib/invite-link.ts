export function inviteUrl(code: string) {
  if (typeof window === 'undefined') return code
  return `${window.location.origin}/invite/${code}`
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
