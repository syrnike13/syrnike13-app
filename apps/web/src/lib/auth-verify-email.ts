const PENDING_VERIFY_EMAIL_KEY = 'auth:pending-verify-email'

export function setPendingVerifyEmail(email: string) {
  if (typeof window === 'undefined') return
  sessionStorage.setItem(PENDING_VERIFY_EMAIL_KEY, email)
}

export function getPendingVerifyEmail() {
  if (typeof window === 'undefined') return ''
  return sessionStorage.getItem(PENDING_VERIFY_EMAIL_KEY) ?? ''
}

export function clearPendingVerifyEmail() {
  if (typeof window === 'undefined') return
  sessionStorage.removeItem(PENDING_VERIFY_EMAIL_KEY)
}
