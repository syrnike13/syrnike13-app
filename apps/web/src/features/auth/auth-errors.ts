import { ApiError } from '#/lib/api/client'

export function isUnauthorizedError(error: unknown) {
  return error instanceof ApiError && error.status === 401
}
