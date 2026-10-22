import { ApiError, ApiNetworkError } from './client'

/**
 * API failures carry developer-facing messages; show the caller's localized
 * fallback instead. Client-side validation errors keep their concrete text.
 */
export function apiErrorMessage(error: unknown, fallback: string): string {
  if (error instanceof ApiError || error instanceof ApiNetworkError) {
    return fallback
  }
  return error instanceof Error && error.message.trim()
    ? error.message
    : fallback
}
