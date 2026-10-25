import { describe, expect, it } from 'vitest'

import { HOLIDAY_CATALOG } from './catalog'
import {
  findHoliday,
  isMonthDayInWindow,
  monthDayKey,
  resolveActiveHoliday,
  toMonthDay,
} from './resolve'

describe('toMonthDay', () => {
  it('drops the year and uses 1-based months', () => {
    expect(toMonthDay(new Date(2026, 9, 31, 23, 59))).toEqual({
      month: 10,
      day: 31,
    })
  })
})

describe('monthDayKey', () => {
  it('zero-pads so keys sort chronologically', () => {
    expect(monthDayKey({ month: 1, day: 5 })).toBe('01-05')
    expect(monthDayKey({ month: 12, day: 31 })).toBe('12-31')
  })
})

describe('isMonthDayInWindow', () => {
  const valentines = {
    from: { month: 2, day: 12 },
    to: { month: 2, day: 15 },
  }

  it('includes both boundaries', () => {
    expect(isMonthDayInWindow({ month: 2, day: 12 }, valentines)).toBe(true)
    expect(isMonthDayInWindow({ month: 2, day: 15 }, valentines)).toBe(true)
  })

  it('excludes days outside the range', () => {
    expect(isMonthDayInWindow({ month: 2, day: 11 }, valentines)).toBe(false)
    expect(isMonthDayInWindow({ month: 2, day: 16 }, valentines)).toBe(false)
  })

  it('wraps windows that cross New Year', () => {
    const winter = {
      from: { month: 12, day: 15 },
      to: { month: 1, day: 14 },
    }
    expect(isMonthDayInWindow({ month: 12, day: 31 }, winter)).toBe(true)
    expect(isMonthDayInWindow({ month: 1, day: 1 }, winter)).toBe(true)
    expect(isMonthDayInWindow({ month: 1, day: 14 }, winter)).toBe(true)
    expect(isMonthDayInWindow({ month: 1, day: 15 }, winter)).toBe(false)
    expect(isMonthDayInWindow({ month: 12, day: 14 }, winter)).toBe(false)
  })
})

describe('resolveActiveHoliday', () => {
  it('returns null on an ordinary day', () => {
    expect(resolveActiveHoliday({ month: 6, day: 15 })).toBeNull()
  })

  it('resolves a holiday from its window', () => {
    expect(resolveActiveHoliday({ month: 10, day: 31 })?.id).toBe('halloween')
  })

  it('keeps New Year through the winter holidays', () => {
    expect(resolveActiveHoliday({ month: 12, day: 31 })?.id).toBe('new-year')
    expect(resolveActiveHoliday({ month: 1, day: 12 })?.id).toBe('new-year')
  })

  it('starts Halloween two weeks early and keeps it a few days after', () => {
    expect(resolveActiveHoliday({ month: 10, day: 16 })).toBeNull()
    expect(resolveActiveHoliday({ month: 10, day: 17 })?.id).toBe('halloween')
    expect(resolveActiveHoliday({ month: 11, day: 3 })?.id).toBe('halloween')
    expect(resolveActiveHoliday({ month: 11, day: 4 })).toBeNull()
  })

  it('runs New Year through December and the old New Year', () => {
    expect(resolveActiveHoliday({ month: 11, day: 30 })).toBeNull()
    expect(resolveActiveHoliday({ month: 12, day: 1 })?.id).toBe('new-year')
    expect(resolveActiveHoliday({ month: 1, day: 14 })?.id).toBe('new-year')
    expect(resolveActiveHoliday({ month: 1, day: 15 })).toBeNull()
  })

  it('keeps holiday windows apart except where priority decides', () => {
    const allowed = new Set(['christmas|new-year', 'new-year|christmas'])
    for (let dayOfYear = 0; dayOfYear < 366; dayOfYear += 1) {
      const date = new Date(2024, 0, 1 + dayOfYear)
      const day = { month: date.getMonth() + 1, day: date.getDate() }
      const active = HOLIDAY_CATALOG.filter((holiday) =>
        holiday.windows.some((window) => isMonthDayInWindow(day, window)),
      ).map((holiday) => holiday.id)
      if (active.length > 1) expect(allowed.has(active.join('|'))).toBe(true)
    }
  })

  it('prefers the higher-priority holiday on overlaps', () => {
    expect(resolveActiveHoliday({ month: 1, day: 7 })?.id).toBe('christmas')
  })
})

describe('findHoliday', () => {
  it('finds a holiday by id and returns null for unknown ids', () => {
    expect(findHoliday('victory-day')?.labelKey).toBe('victoryDay')
    expect(findHoliday('unknown-holiday')).toBeNull()
  })
})

describe('HOLIDAY_CATALOG', () => {
  it('has unique ids and translation keys', () => {
    const ids = HOLIDAY_CATALOG.map((holiday) => holiday.id)
    const labelKeys = HOLIDAY_CATALOG.map((holiday) => holiday.labelKey)
    expect(new Set(ids).size).toBe(ids.length)
    expect(new Set(labelKeys).size).toBe(labelKeys.length)
  })

  it('uses valid calendar days', () => {
    for (const holiday of HOLIDAY_CATALOG) {
      for (const { from, to } of holiday.windows) {
        for (const day of [from, to]) {
          expect(day.month).toBeGreaterThanOrEqual(1)
          expect(day.month).toBeLessThanOrEqual(12)
          expect(day.day).toBeGreaterThanOrEqual(1)
          expect(day.day).toBeLessThanOrEqual(31)
        }
      }
    }
  })
})
