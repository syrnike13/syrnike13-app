import { ulidTimestampMs } from '@syrnike13/client/lib/ulid'

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR
const MONTH = 30 * DAY
const YEAR = 365 * DAY

/** Discord-style short age of a ULID, as an i18n key under `mobile.time` and a count. */
export function shortAge(id: string, now = Date.now()) {
  const age = Math.max(0, now - ulidTimestampMs(id))
  if (age < MINUTE) return { key: 'now', count: 0 } as const
  if (age < HOUR) return { key: 'minutes', count: Math.floor(age / MINUTE) } as const
  if (age < DAY) return { key: 'hours', count: Math.floor(age / HOUR) } as const
  if (age < MONTH) return { key: 'days', count: Math.floor(age / DAY) } as const
  if (age < YEAR) return { key: 'months', count: Math.floor(age / MONTH) } as const
  return { key: 'years', count: Math.floor(age / YEAR) } as const
}
