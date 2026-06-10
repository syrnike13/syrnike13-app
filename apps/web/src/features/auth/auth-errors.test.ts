import { describe, expect, it } from 'vitest'

import { ApiError, ApiNetworkError } from '#/lib/api/client'

import {
  isSessionInvalidatingError,
  isTransientAuthLoadError,
  isUnauthorizedError,
} from './auth-errors'

describe('auth error classification', () => {
  it('treats only explicit authorization failures as session-invalidating', () => {
    expect(isUnauthorizedError(new ApiError('Unauthorized', 401))).toBe(true)
    expect(
      isSessionInvalidatingError(new ApiError('Unauthorized', 401)),
    ).toBe(true)

    expect(
      isSessionInvalidatingError(
        new ApiNetworkError('Network request failed', new TypeError('offline')),
      ),
    ).toBe(false)
    expect(isSessionInvalidatingError(new ApiError('Internal', 500))).toBe(
      false,
    )
    expect(isSessionInvalidatingError(new Error('Failed to fetch'))).toBe(false)
  })

  it('treats network and retryable HTTP failures as transient auth load errors', () => {
    expect(
      isTransientAuthLoadError(
        new ApiNetworkError('Network request failed', new TypeError('offline')),
      ),
    ).toBe(true)
    expect(isTransientAuthLoadError(new ApiError('Timeout', 408))).toBe(true)
    expect(isTransientAuthLoadError(new ApiError('Too many requests', 429))).toBe(true)
    expect(isTransientAuthLoadError(new ApiError('Bad gateway', 502))).toBe(true)
    expect(isTransientAuthLoadError(new ApiError('Unavailable', 503))).toBe(true)
    expect(isTransientAuthLoadError(new ApiError('Gateway timeout', 504))).toBe(true)

    expect(isTransientAuthLoadError(new ApiError('Unauthorized', 401))).toBe(false)
    expect(isTransientAuthLoadError(new ApiError('Internal', 500))).toBe(false)
    expect(isTransientAuthLoadError(new Error('Unknown'))).toBe(false)
  })
})
