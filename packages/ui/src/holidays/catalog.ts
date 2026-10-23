/**
 * Central holiday catalog for seasonal icons and the developer preview.
 *
 * Dates are local calendar days without a year: a holiday is active every year
 * in the same window. A window whose `from` is later than `to` wraps across
 * New Year (for example Dec 15 → Jan 14). Times of day and timezones are
 * intentionally absent: seasonal icons follow the viewer's local clock.
 *
 * To add a holiday, append an entry here and translate its `labelKey` in the
 * app's `holidays` message namespace. Seasonal icon artwork is registered
 * separately in the app via `defineHolidayIcon`.
 */

/** Calendar day in the viewer's local timezone; `month` is 1-12. */
export type MonthDay = {
  readonly month: number
  readonly day: number
}

/** Inclusive date range in which a holiday is active. */
export type HolidayWindow = {
  readonly from: MonthDay
  readonly to: MonthDay
}

export type HolidayDefinition = {
  readonly id: string
  /** Key inside the app's `holidays` i18n namespace. */
  readonly labelKey: string
  readonly windows: readonly HolidayWindow[]
  /**
   * Wins over lower values when several holidays are active on the same day.
   * Absent means 0. Equal priorities resolve to the first catalog entry.
   */
  readonly priority?: number
}

const day = (month: number, day: number): MonthDay => ({ month, day })

export const HOLIDAY_CATALOG = [
  {
    id: 'new-year',
    labelKey: 'newYear',
    // The New Year window extends through the old New Year.
    windows: [{ from: day(12, 15), to: day(1, 14) }],
    priority: 10,
  },
  {
    id: 'christmas',
    labelKey: 'christmas',
    // Orthodox Christmas takes priority over the surrounding New Year window.
    windows: [{ from: day(1, 6), to: day(1, 8) }],
    priority: 20,
  },
  {
    id: 'valentines-day',
    labelKey: 'valentinesDay',
    windows: [{ from: day(2, 12), to: day(2, 15) }],
    priority: 10,
  },
  {
    id: 'defender-day',
    labelKey: 'defenderDay',
    windows: [{ from: day(2, 21), to: day(2, 24) }],
    priority: 10,
  },
  {
    id: 'womens-day',
    labelKey: 'womensDay',
    windows: [{ from: day(3, 6), to: day(3, 9) }],
    priority: 10,
  },
  {
    id: 'cosmonautics-day',
    labelKey: 'cosmonauticsDay',
    windows: [{ from: day(4, 11), to: day(4, 13) }],
    priority: 10,
  },
  {
    id: 'spring-and-labour-day',
    labelKey: 'springAndLabourDay',
    windows: [{ from: day(4, 29), to: day(5, 2) }],
    priority: 10,
  },
  {
    id: 'victory-day',
    labelKey: 'victoryDay',
    windows: [{ from: day(5, 7), to: day(5, 10) }],
    priority: 10,
  },
  {
    id: 'halloween',
    labelKey: 'halloween',
    windows: [{ from: day(10, 29), to: day(11, 1) }],
    priority: 10,
  },
] as const satisfies readonly HolidayDefinition[]

export type HolidayId = (typeof HOLIDAY_CATALOG)[number]['id']
