import { ApiError } from '#/lib/api/client'

const inFlight = new Map<string, Promise<unknown>>()
const lastRequestAt = new Map<string, number>()
const blockedUntil = new Map<string, number>()

const DEFAULT_MIN_INTERVAL_MS = 5_000
const RATE_LIMIT_BACKOFF_MS = 60_000

export function isRateLimitedError(error: unknown) {
  return error instanceof ApiError && error.status === 429
}

function backoffMs(error: unknown) {
  return isRateLimitedError(error) ? RATE_LIMIT_BACKOFF_MS : 0
}

function registerBackoff(key: string, error: unknown) {
  const ms = backoffMs(error)
  if (ms > 0) {
    blockedUntil.set(key, Date.now() + ms)
  }
}

function isBlocked(key: string) {
  const until = blockedUntil.get(key) ?? 0
  return Date.now() < until
}

/**
 * Дедупликация и минимальный интервал между одинаковыми запросами.
 */
export function runVoiceRequest<T>(
  key: string,
  fn: () => Promise<T>,
  minIntervalMs = DEFAULT_MIN_INTERVAL_MS,
): Promise<T | undefined> {
  if (isBlocked(key)) {
    return Promise.resolve(undefined)
  }

  const existing = inFlight.get(key)
  if (existing) {
    return existing as Promise<T | undefined>
  }

  const lastAt = lastRequestAt.get(key) ?? 0
  const elapsed = Date.now() - lastAt
  if (elapsed < minIntervalMs) {
    return Promise.resolve(undefined)
  }

  const promise = (async () => {
    try {
      const result = await fn()
      lastRequestAt.set(key, Date.now())
      return result
    } catch (error) {
      registerBackoff(key, error)
      throw error
    } finally {
      inFlight.delete(key)
    }
  })()

  inFlight.set(key, promise)
  return promise
}
