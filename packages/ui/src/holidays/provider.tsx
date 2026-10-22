import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react'

import {
  HOLIDAY_CATALOG,
  type HolidayDefinition,
  type HolidayId,
  type MonthDay,
} from './catalog'
import {
  findHoliday,
  monthDayKey,
  resolveActiveHoliday,
  toMonthDay,
} from './resolve'

export type HolidayOverride = 'auto' | 'off' | HolidayId

type ActiveHoliday = {
  holiday: HolidayDefinition
  source: 'date' | 'override'
}

type HolidayContextValue = {
  active: ActiveHoliday | null
  override: HolidayOverride
  setOverride: (override: HolidayOverride) => void
  today: MonthDay
  todayKey: string
}

const HolidayContext = createContext<HolidayContextValue | null>(null)

const DEFAULT_REFRESH_INTERVAL_MS = 60_000

function readStoredOverride(storageKey: string | undefined): HolidayOverride {
  if (!storageKey || typeof window === 'undefined') return 'auto'
  try {
    const stored = window.localStorage.getItem(storageKey)
    if (stored === 'auto' || stored === 'off') return stored
    return HOLIDAY_CATALOG.find((holiday) => holiday.id === stored)?.id ?? 'auto'
  } catch {
    return 'auto'
  }
}

export type HolidayProviderProps = {
  children: ReactNode
  /** Catalog override for tests and experiments. */
  catalog?: readonly HolidayDefinition[]
  /** Injectable clock for tests; keep the reference stable between renders. */
  now?: () => Date
  /** How often the local date is re-checked, so a holiday ends at midnight. */
  refreshIntervalMs?: number
  /** Dev-only persistence. Production must leave this undefined. */
  overrideStorageKey?: string
}

/**
 * Resolves the holiday that is active on the viewer's local date and publishes
 * it to seasonal surfaces such as icon variants.
 *
 * The provider is the single date authority: components ask it instead of
 * reading the clock themselves, and it re-checks the day on an interval so a
 * long-running session crosses midnight without a reload.
 */
export function HolidayProvider({
  children,
  catalog = HOLIDAY_CATALOG,
  now,
  refreshIntervalMs = DEFAULT_REFRESH_INTERVAL_MS,
  overrideStorageKey,
}: HolidayProviderProps) {
  const [today, setToday] = useState<MonthDay>(() =>
    toMonthDay(now ? now() : new Date()),
  )
  const [override, setOverrideState] = useState<HolidayOverride>('auto')

  useEffect(() => {
    setOverrideState(readStoredOverride(overrideStorageKey))
  }, [overrideStorageKey])

  useEffect(() => {
    const readToday = now ?? (() => new Date())
    const interval = window.setInterval(() => {
      setToday((current) => {
        const next = toMonthDay(readToday())
        return next.month === current.month && next.day === current.day
          ? current
          : next
      })
    }, refreshIntervalMs)
    return () => window.clearInterval(interval)
  }, [now, refreshIntervalMs])

  const setOverride = useCallback(
    (next: HolidayOverride) => {
      setOverrideState(next)
      if (!overrideStorageKey) return
      try {
        window.localStorage.setItem(overrideStorageKey, next)
      } catch {
        // Keep the preview usable when browser storage is unavailable.
      }
    },
    [overrideStorageKey],
  )

  const active = useMemo<ActiveHoliday | null>(() => {
    if (override === 'off') return null
    if (override !== 'auto') {
      const holiday = findHoliday(override, catalog)
      if (holiday) return { holiday, source: 'override' }
    }
    const holiday = resolveActiveHoliday(today, catalog)
    return holiday ? { holiday, source: 'date' } : null
  }, [catalog, override, today])

  const value = useMemo<HolidayContextValue>(
    () => ({ active, override, setOverride, today, todayKey: monthDayKey(today) }),
    [active, override, setOverride, today],
  )

  return (
    <HolidayContext.Provider value={value}>
      {children}
    </HolidayContext.Provider>
  )
}

/**
 * The holiday that is active right now, or `null` on ordinary days.
 *
 * Also returns `null` without a provider, so icon registries and isolated tests
 * work before the provider is mounted.
 */
export function useActiveHoliday(): HolidayDefinition | null {
  return useContext(HolidayContext)?.active?.holiday ?? null
}

/** Developer preview controls; does not mount effects or modify document CSS. */
export function useHolidayPreview() {
  const context = useContext(HolidayContext)
  if (!context) {
    throw new Error('useHolidayPreview requires HolidayProvider')
  }
  return context
}
