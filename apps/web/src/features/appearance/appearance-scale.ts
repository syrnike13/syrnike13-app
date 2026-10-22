import {
  APPEARANCE_SCALE_MAX,
  APPEARANCE_SCALE_MIN,
} from '@syrnike13/platform'

/**
 * Applies the interface scale through the root font size: the design system
 * sizes layout in rem, so every screen follows without a separate pixel pass.
 */
export function applyAppearanceScale(scale: number) {
  if (typeof document === 'undefined') return
  if (!Number.isFinite(scale)) return
  const percent = Math.round(
    Math.min(APPEARANCE_SCALE_MAX, Math.max(APPEARANCE_SCALE_MIN, scale)),
  )
  document.documentElement.style.fontSize = `${percent}%`
}
