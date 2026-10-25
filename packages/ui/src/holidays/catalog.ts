/**
 * Central holiday catalog for seasonal icons and the developer preview.
 *
 * Dates are local calendar days without a year: a holiday is active every year
 * in the same window, from about a week before the day to a few days after it,
 * so the dressing builds up and lingers. Windows of different holidays do not
 * overlap unless one wins by priority (Christmas inside New Year). A window
 * whose `from` is later than `to` wraps across New Year (Dec 1 → Jan 14). Times of day and timezones are
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
    // All of December, through the old New Year.
    windows: [{ from: day(12, 1), to: day(1, 14) }],
    priority: 10,
  },
  {
    id: 'christmas',
    labelKey: 'christmas',
    // Orthodox Christmas takes priority over the surrounding New Year window.
    windows: [{ from: day(1, 4), to: day(1, 9) }],
    priority: 20,
  },
  {
    id: 'valentines-day',
    labelKey: 'valentinesDay',
    windows: [{ from: day(2, 7), to: day(2, 16) }],
    priority: 10,
  },
  {
    id: 'defender-day',
    labelKey: 'defenderDay',
    windows: [{ from: day(2, 17), to: day(2, 25) }],
    priority: 10,
  },
  {
    id: 'womens-day',
    labelKey: 'womensDay',
    windows: [{ from: day(3, 1), to: day(3, 10) }],
    priority: 10,
  },
  {
    id: 'cosmonautics-day',
    labelKey: 'cosmonauticsDay',
    windows: [{ from: day(4, 6), to: day(4, 14) }],
    priority: 10,
  },
  {
    id: 'spring-and-labour-day',
    labelKey: 'springAndLabourDay',
    windows: [{ from: day(4, 24), to: day(5, 3) }],
    priority: 10,
  },
  {
    id: 'victory-day',
    labelKey: 'victoryDay',
    windows: [{ from: day(5, 4), to: day(5, 11) }],
    priority: 10,
  },
  {
    id: 'halloween',
    labelKey: 'halloween',
    // Two weeks of build-up before Oct 31 and a few days after.
    windows: [{ from: day(10, 17), to: day(11, 3) }],
    priority: 10,
  },
] as const satisfies readonly HolidayDefinition[]

export type HolidayId = (typeof HOLIDAY_CATALOG)[number]['id']
