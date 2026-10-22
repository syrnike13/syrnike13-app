import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
} from 'react'
import { Slider } from '@syrnike13/ui/primitives/slider'
import type { CSSVars } from '#/lib/css-vars'
import { cn } from '#/lib/utils'
import {
  firstEnabledStop,
  getSliderBounds,
  getSliderStep,
  getValueStep,
  lastEnabledStop,
  moveEnabledStop,
  nearestEnabledStop,
  nearestStopIncludingDisabled,
  normalizePresetStops,
  sliderLabel,
  sliderPositionToValue,
  sliderValueText,
  stopAtValue,
  valueToSliderPosition,
  type NormalizedPresetStop,
  type PresetSliderDrag,
  type PresetSliderLayout,
  type PresetSliderMode,
  type PresetSliderStop,
} from '#/components/ui/preset-slider-logic'

export type { PresetSliderDrag, PresetSliderLayout, PresetSliderMode }
export type { PresetSliderStop }

export type PresetSliderProps = {
  /** Ordered stop list; sorted and deduplicated by value internally. */
  stops: readonly PresetSliderStop[]
  /** Current value in the consumer's units. */
  value: number
  onValueChange: (value: number) => void
  /** Fired on pointer release, Enter or a label click. */
  onValueCommitted?: (value: number) => void
  /** `stops` snaps to stops, `continuous` allows values between them. */
  mode?: PresetSliderMode
  /** `value` spaces stops by value, `index` spaces them evenly. */
  layout?: PresetSliderLayout
  /** In `stops` mode: move stop-to-stop while dragging or snap on release. */
  drag?: PresetSliderDrag
  /** Keyboard step for continuous mode; defaults to 1% of the range. */
  step?: number
  /** Render the label row above the scale; defaults to true. */
  showLabels?: boolean
  /** Render ticks on the scale; defaults to true. */
  showMarks?: boolean
  formatValue?: (value: number) => string
  disabled?: boolean
  className?: string
  'aria-label': string
}

function readSliderValue(value: number | readonly number[]): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  const first = value[0]
  return first != null && Number.isFinite(first) ? first : null
}

function clampValue(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value))
}

/**
 * Discrete or continuous slider with labelled stops.
 *
 * Positions are linear by value (`layout="value"`) or spread evenly across
 * stop indices (`layout="index"`). In the index layout the slider input works
 * in index space, so `aria-valuetext` carries the real value while the native
 * minimum/maximum stay indices.
 */
export function PresetSlider({
  stops: stopsProp,
  value,
  onValueChange,
  onValueCommitted,
  mode = 'stops',
  layout = 'value',
  drag = 'snap',
  step,
  showLabels = true,
  showMarks = true,
  formatValue,
  disabled,
  className,
  'aria-label': ariaLabel,
}: PresetSliderProps) {
  const stops = useMemo(() => normalizePresetStops(stopsProp), [stopsProp])
  const [draft, setDraft] = useState<number | null>(null)
  const lastEmittedRef = useRef(value)
  const labelId = useId()

  const { min: sliderMin, max: sliderMax } = getSliderBounds(stops, layout)
  const firstValue = stops[0]?.value ?? 0
  const lastValue = stops[stops.length - 1]?.value ?? 0
  const safeValue = Number.isFinite(value) ? value : firstValue
  const valuePosition = valueToSliderPosition(safeValue, stops, layout)

  const normalizedValue =
    mode === 'continuous'
      ? clampValue(safeValue, firstValue, lastValue)
      : (nearestEnabledStop(stops, valuePosition, layout) ??
          nearestStopIncludingDisabled(stops, valuePosition, layout) ??
          stops[0]
        )?.value ?? safeValue

  const stopsKey = stops
    .map(
      (stop) =>
        `${stop.value}:${stop.disabled ? 1 : 0}:${stop.major ? 1 : 0}:${stop.label ?? ''}`,
    )
    .join('|')

  useEffect(() => {
    lastEmittedRef.current = value
  }, [value])

  useEffect(() => {
    setDraft(null)
  }, [value, mode, layout, drag, stopsKey])

  const emitValue = useCallback(
    (nextValue: number) => {
      if (nextValue === lastEmittedRef.current) return
      lastEmittedRef.current = nextValue
      onValueChange(nextValue)
    },
    [onValueChange],
  )

  const commitValue = useCallback(
    (nextValue: number) => {
      setDraft(null)
      emitValue(nextValue)
      onValueCommitted?.(nextValue)
    },
    [emitValue, onValueCommitted],
  )

  const sliderPosition =
    draft ?? valueToSliderPosition(normalizedValue, stops, layout)

  const selectedStop = (() => {
    if (mode === 'stops') {
      if (draft != null) return nearestEnabledStop(stops, draft, layout)
      return stopAtValue(stops, normalizedValue)
    }
    const exact = stopAtValue(stops, normalizedValue)
    return exact && !exact.disabled ? exact : null
  })()

  const ticks = useMemo(
    () =>
      showMarks
        ? stops.map((stop) => ({
            value: valueToSliderPosition(stop.value, stops, layout),
            disabled: stop.disabled,
          }))
        : [],
    [stops, layout, showMarks],
  )

  const inputStep = getSliderStep(stops, layout, mode, step)
  const valueStep = getValueStep(stops, step)

  const markProgress = useCallback(
    (markValue: number) => {
      const range = sliderMax - sliderMin
      return range > 0
        ? clampValue((markValue - sliderMin) / range, 0, 1)
        : 0
    },
    [sliderMax, sliderMin],
  )

  const handleSliderValueChange = (next: number | readonly number[]) => {
    const position = readSliderValue(next)
    if (position == null || stops.length < 2) return

    if (mode === 'continuous') {
      emitValue(
        clampValue(
          sliderPositionToValue(position, stops, layout),
          firstValue,
          lastValue,
        ),
      )
      return
    }

    if (drag === 'snap') {
      const target = nearestEnabledStop(stops, position, layout)
      if (target) emitValue(target.value)
      return
    }

    setDraft(position)
  }

  const handleSliderValueCommitted = (next: number | readonly number[]) => {
    const position = readSliderValue(next)
    if (position == null || stops.length < 2) return

    if (mode === 'continuous') {
      commitValue(
        clampValue(
          sliderPositionToValue(position, stops, layout),
          firstValue,
          lastValue,
        ),
      )
      return
    }

    const target = nearestEnabledStop(stops, position, layout)
    if (target) commitValue(target.value)
  }

  const selectStop = (stop: NormalizedPresetStop) => {
    if (disabled || stop.disabled) return
    commitValue(stop.value)
  }

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (disabled || stops.length < 2) return
    if (event.altKey || event.ctrlKey || event.metaKey) return

    const { key } = event
    const forward =
      key === 'ArrowRight' || key === 'ArrowUp' || key === 'PageUp'
    const backward =
      key === 'ArrowLeft' || key === 'ArrowDown' || key === 'PageDown'
    const isEdge = key === 'Home' || key === 'End'
    if (!forward && !backward && !isEdge) return

    event.preventDefault()
    event.stopPropagation()

    if (mode === 'stops') {
      if (key === 'Home') {
        const target = firstEnabledStop(stops)
        if (target) commitValue(target.value)
        return
      }
      if (key === 'End') {
        const target = lastEnabledStop(stops)
        if (target) commitValue(target.value)
        return
      }

      const steps =
        key === 'PageUp' || key === 'PageDown' || event.shiftKey ? 5 : 1
      const target = moveEnabledStop(
        stops,
        normalizedValue,
        forward ? 1 : -1,
        steps,
      )
      if (target) commitValue(target.value)
      return
    }

    const multiplier =
      key === 'PageUp' || key === 'PageDown' || event.shiftKey ? 10 : 1
    let nextValue: number
    if (key === 'Home') {
      nextValue = firstValue
    } else if (key === 'End') {
      nextValue = lastValue
    } else {
      nextValue =
        normalizedValue + (forward ? 1 : -1) * valueStep * multiplier
    }
    commitValue(clampValue(nextValue, firstValue, lastValue))
  }

  const getAriaValueText = useCallback(
    (_formattedValue: string, sliderValue: number) => {
      const actual =
        layout === 'value'
          ? sliderValue
          : sliderPositionToValue(sliderValue, stops, layout)
      return sliderValueText(
        stopAtValue(stops, actual) ?? { value: actual },
        formatValue,
      )
    },
    [formatValue, layout, stops],
  )

  if (stops.length < 2) return null

  return (
    <div
      className={cn('@container w-full', className)}
      style={
        {
          '--slider-thumb-size': showMarks ? '1.125rem' : '0.75rem',
        } as CSSVars
      }
      onKeyDownCapture={handleKeyDown}
    >
      {showLabels ? (
        <div
          aria-hidden
          className={cn(
            'relative mb-1 h-5',
            disabled && 'pointer-events-none opacity-50',
          )}
        >
          {stops.map((stop) => {
            const isFirst = stop.index === 0
            const isLast = stop.index === stops.length - 1
            const selected = !stop.disabled && selectedStop?.value === stop.value
            const label = sliderLabel(stop, formatValue)
            const labelText =
              label ?? (selected ? sliderValueText(stop, formatValue) : null)
            if (labelText == null) return null
            const alwaysVisible =
              selected || stop.major || isFirst || isLast
            const progress = markProgress(
              valueToSliderPosition(stop.value, stops, layout),
            )

            return (
              <span
                key={stop.value}
                data-slot="preset-slider-label"
                data-value={stop.value}
                data-selected={selected ? '' : undefined}
                data-disabled={stop.disabled ? '' : undefined}
                className={cn(
                  'absolute bottom-0 whitespace-nowrap text-xs leading-4 tabular-nums transition-colors',
                  isFirst
                    ? 'left-0'
                    : isLast
                      ? 'right-0'
                      : 'slider-mark-position -translate-x-1/2',
                  selected
                    ? 'text-success-strong'
                    : stop.disabled
                      ? 'text-muted-foreground/50'
                      : 'cursor-pointer text-muted-foreground hover:text-foreground',
                  !alwaysVisible && '@max-2xl:hidden',
                )}
                style={
                  {
                    '--slider-mark-progress': progress,
                  } as CSSVars
                }
                onClick={() => selectStop(stop)}
              >
                {labelText}
              </span>
            )
          })}
        </div>
      ) : null}
      <Slider
        value={[sliderPosition]}
        min={sliderMin}
        max={sliderMax}
        step={inputStep}
        marks={ticks}
        disabled={disabled}
        aria-labelledby={labelId}
        getAriaValueText={getAriaValueText}
        onValueChange={handleSliderValueChange}
        onValueCommitted={handleSliderValueCommitted}
      />
      <span id={labelId} className="sr-only">
        {ariaLabel}
      </span>
    </div>
  )
}
