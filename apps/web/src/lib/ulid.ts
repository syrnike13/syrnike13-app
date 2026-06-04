const ULID_ENCODING = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'

/** Время создания из ULID (первые 48 бит — unix ms). */
export function ulidTimestampMs(id: string): number {
  if (id.length < 10) return Date.now()

  let time = 0
  for (let i = 0; i < 10; i++) {
    const value = ULID_ENCODING.indexOf(id[i]!.toUpperCase())
    if (value < 0) return Date.now()
    time = time * 32 + value
  }
  return time
}

export function ulidToDate(id: string): Date {
  return new Date(ulidTimestampMs(id))
}
