export type PresetSliderStop = {
  value: number
  /**
   * Visible label. `undefined` falls back to `formatValue` or the number;
   * `null` renders only the tick and reveals the value when selected.
   */
  label?: string | null
  /** Stays visible on narrow containers. */
  major?: boolean
  disabled?: boolean
}

export type NormalizedPresetStop = PresetSliderStop & { index: number }

export type PresetSliderMode = 'stops' | 'continuous'
export type PresetSliderLayout = 'value' | 'index'
export type PresetSliderDrag = 'snap' | 'release'

const EPSILON = 1e-9

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

/** Sorts, drops non-finite and duplicate values, and numbers the stops. */
export function normalizePresetStops(
  stops: readonly PresetSliderStop[],
): NormalizedPresetStop[] {
  const seen = new Set<number>()
  return stops
    .filter((stop) => Number.isFinite(stop.value))
    .slice()
    .sort((left, right) => left.value - right.value)
    .filter((stop) => {
      if (seen.has(stop.value)) return false
      seen.add(stop.value)
      return true
    })
    .map((stop, index) => ({ ...stop, index }))
}

/** Slider-space bounds: real values or stop indices. */
export function getSliderBounds(
  stops: readonly NormalizedPresetStop[],
  layout: PresetSliderLayout,
): { min: number; max: number } {
  return layout === 'index'
    ? { min: 0, max: Math.max(0, stops.length - 1) }
    : {
        min: stops[0]?.value ?? 0,
        max: stops[stops.length - 1]?.value ?? 0,
      }
}

/**
 * Maps a real value to its position on the slider. `index` layout spreads
 * stops evenly; values between stops interpolate inside their segment.
 */
export function valueToSliderPosition(
  value: number,
  stops: readonly NormalizedPresetStop[],
  layout: PresetSliderLayout,
): number {
  if (stops.length === 0) return 0
  if (layout === 'value') {
    return clamp(
      value,
      stops[0].value,
      stops[stops.length - 1].value,
    )
  }

  const first = stops[0]
  const last = stops[stops.length - 1]
  const clamped = clamp(value, first.value, last.value)
  for (let index = 0; index < stops.length - 1; index += 1) {
    const left = stops[index]
    const right = stops[index + 1]
    if (clamped <= right.value) {
      const span = right.value - left.value
      return span > 0
        ? index + (clamped - left.value) / span
        : index
    }
  }
  return stops.length - 1
}

/** Inverse of {@link valueToSliderPosition}. */
export function sliderPositionToValue(
  position: number,
  stops: readonly NormalizedPresetStop[],
  layout: PresetSliderLayout,
): number {
  if (stops.length === 0) return 0
  if (layout === 'value') {
    return clamp(position, stops[0].value, stops[stops.length - 1].value)
  }

  const clamped = clamp(position, 0, stops.length - 1)
  const index = Math.floor(clamped)
  if (index >= stops.length - 1) return stops[stops.length - 1].value
  const progress = clamped - index
  const left = stops[index]
  const right = stops[index + 1]
  return left.value + progress * (right.value - left.value)
}

export function stopAtValue(
  stops: readonly NormalizedPresetStop[],
  value: number,
): NormalizedPresetStop | null {
  return (
    stops.find((stop) => Math.abs(stop.value - value) < EPSILON) ?? null
  )
}

function nearestStop(
  stops: readonly NormalizedPresetStop[],
  position: number,
  layout: PresetSliderLayout,
  includeDisabled: boolean,
): NormalizedPresetStop | null {
  let best: NormalizedPresetStop | null = null
  let bestDistance = Number.POSITIVE_INFINITY

  for (const stop of stops) {
    if (!includeDisabled && stop.disabled) continue
    const distance = Math.abs(
      valueToSliderPosition(stop.value, stops, layout) - position,
    )
    if (distance < bestDistance - EPSILON) {
      best = stop
      bestDistance = distance
    }
  }

  return best
}

/** Nearest selectable stop to a slider position; ties prefer the lower stop. */
export function nearestEnabledStop(
  stops: readonly NormalizedPresetStop[],
  position: number,
  layout: PresetSliderLayout,
): NormalizedPresetStop | null {
  return nearestStop(stops, position, layout, false)
}

export function nearestStopIncludingDisabled(
  stops: readonly NormalizedPresetStop[],
  position: number,
  layout: PresetSliderLayout,
): NormalizedPresetStop | null {
  return nearestStop(stops, position, layout, true)
}

export function firstEnabledStop(
  stops: readonly NormalizedPresetStop[],
): NormalizedPresetStop | null {
  return stops.find((stop) => !stop.disabled) ?? null
}

export function lastEnabledStop(
  stops: readonly NormalizedPresetStop[],
): NormalizedPresetStop | null {
  for (let index = stops.length - 1; index >= 0; index -= 1) {
    if (!stops[index].disabled) return stops[index]
  }
  return null
}

/**
 * Moves from the current value to the next/previous selectable stop.
 * `steps` counts selectable stops, so disabled stops are skipped.
 */
export function moveEnabledStop(
  stops: readonly NormalizedPresetStop[],
  currentValue: number,
  direction: 1 | -1,
  steps = 1,
): NormalizedPresetStop | null {
  const enabled = stops.filter((stop) => !stop.disabled)
  if (enabled.length === 0) return null

  let index = -1
  if (direction > 0) {
    index = enabled.findIndex((stop) => stop.value > currentValue + EPSILON)
  } else {
    for (let cursor = enabled.length - 1; cursor >= 0; cursor -= 1) {
      if (enabled[cursor].value < currentValue - EPSILON) {
        index = cursor
        break
      }
    }
  }
  if (index === -1) return null

  const target = clamp(index + (steps - 1) * direction, 0, enabled.length - 1)
  return enabled[target]
}

/** Largest uniform step the slider input may use without skipping a stop. */
export function getSliderStep(
  stops: readonly NormalizedPresetStop[],
  layout: PresetSliderLayout,
  mode: PresetSliderMode,
  step?: number,
): number {
  if (mode === 'continuous') {
    if (layout === 'index') return 0.01
    const range = (stops[stops.length - 1]?.value ?? 0) - (stops[0]?.value ?? 0)
    return step && step > 0 ? step : range > 0 ? range / 100 : 1
  }
  if (layout === 'index') return 1

  let smallestGap = Number.POSITIVE_INFINITY
  for (let index = 0; index < stops.length - 1; index += 1) {
    smallestGap = Math.min(
      smallestGap,
      stops[index + 1].value - stops[index].value,
    )
  }
  return Number.isFinite(smallestGap) && smallestGap > 0
    ? smallestGap / 100
    : 1
}

/** Keyboard increment for continuous mode, in real value units. */
export function getValueStep(
  stops: readonly NormalizedPresetStop[],
  step?: number,
): number {
  if (step && step > 0) return step
  const range = (stops[stops.length - 1]?.value ?? 0) - (stops[0]?.value ?? 0)
  return range > 0 ? range / 100 : 1
}

/** Always-present text for ARIA and for a selected stop without a label. */
export function sliderValueText(
  stop: Pick<PresetSliderStop, 'value' | 'label'>,
  formatValue?: (value: number) => string,
): string {
  if (stop.label != null) return stop.label
  if (formatValue) return formatValue(stop.value)
  // Trim float dust from index-space interpolation without inventing precision.
  return String(Math.round(stop.value * 1e6) / 1e6)
}

/** Visible label; `null` means the stop is shown as a tick only. */
export function sliderLabel(
  stop: Pick<PresetSliderStop, 'value' | 'label'>,
  formatValue?: (value: number) => string,
): string | null {
  if (stop.label === null) return null
  return sliderValueText(stop, formatValue)
}
