import {
  HOLIDAY_CATALOG,
  type HolidayDefinition,
  type HolidayWindow,
  type MonthDay,
} from './catalog'

/** Local calendar day of `date`; the year is dropped on purpose. */
export function toMonthDay(date: Date): MonthDay {
  return { month: date.getMonth() + 1, day: date.getDate() }
}

/** Stable `MM-DD` key that also sorts correctly as a string. */
export function monthDayKey({ month, day }: MonthDay): string {
  return `${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`
}

/** Inclusive check; windows that wrap across New Year are supported. */
export function isMonthDayInWindow(
  day: MonthDay,
  window: HolidayWindow,
): boolean {
  const value = monthDayKey(day)
  const from = monthDayKey(window.from)
  const to = monthDayKey(window.to)
  return from <= to
    ? value >= from && value <= to
    : value >= from || value <= to
}

export function findHoliday(
  id: string,
  catalog: readonly HolidayDefinition[] = HOLIDAY_CATALOG,
): HolidayDefinition | null {
  return catalog.find((holiday) => holiday.id === id) ?? null
}

/**
 * Holiday with the highest priority whose window contains `day`.
 * Returns `null` on ordinary days, so icons keep their base glyphs.
 */
export function resolveActiveHoliday(
  day: MonthDay,
  catalog: readonly HolidayDefinition[] = HOLIDAY_CATALOG,
): HolidayDefinition | null {
  let active: HolidayDefinition | null = null

  for (const holiday of catalog) {
    if (!holiday.windows.some((window) => isMonthDayInWindow(day, window))) {
      continue
    }
    if (active && (holiday.priority ?? 0) <= (active.priority ?? 0)) continue
    active = holiday
  }

  return active
}
