import { useActiveHoliday, type HolidayId } from '@syrnike13/ui/holidays'

import { defineIcon } from './define-icon'
import type { AppIcon, AppIconProps, DefinedIcon, IconSource } from './types'

export type HolidayIconVariants = Partial<Record<HolidayId, AppIcon>>

/**
 * Registers an app icon together with optional holiday variants.
 *
 * The stable icon name (`HomeIcon`, `HashIcon`, …) stays the same for every
 * call site; the variant is picked from the holiday resolved by
 * `HolidayProvider`. Without a provider (tests, isolated stories) or outside a
 * holiday window the base icon renders.
 */
export function defineHolidayIcon(
  baseComponent: unknown,
  source: IconSource,
  variants: HolidayIconVariants,
): DefinedIcon {
  const base = baseComponent as AppIcon

  function HolidayIcon(props: AppIconProps) {
    const holiday = useActiveHoliday()
    // The provider publishes entries from the app catalog, so the id is a known
    // `HolidayId`; custom catalogs are only used in tests.
    const Variant = holiday ? variants[holiday.id as HolidayId] : undefined
    const Component = Variant ?? base
    return <Component {...props} />
  }

  if (import.meta.env.DEV) {
    HolidayIcon.displayName = `${source.name}@holiday`
  }

  return defineIcon(HolidayIcon, source)
}
