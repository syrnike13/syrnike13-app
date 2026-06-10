import { describe, expect, it } from 'vitest'

import { ApiError, ApiNetworkError } from '#/lib/api/client'

import {
  isSessionInvalidatingError,
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
})
