export function inviteUrl(code: string) {
  if (typeof window === 'undefined') return code
  return `${window.location.origin}/invite/${code}`
}
