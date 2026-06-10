import { ApiError, ApiNetworkError } from '#/lib/api/client'

const TRANSIENT_AUTH_LOAD_STATUSES = new Set([408, 429, 502, 503, 504])

export function isUnauthorizedError(error: unknown) {
  return error instanceof ApiError && error.status === 401
}

export function isSessionInvalidatingError(error: unknown) {
  return isUnauthorizedError(error)
}

export function isTransientAuthLoadError(error: unknown) {
  if (error instanceof ApiNetworkError) return true
  return (
    error instanceof ApiError &&
    TRANSIENT_AUTH_LOAD_STATUSES.has(error.status)
  )
}
