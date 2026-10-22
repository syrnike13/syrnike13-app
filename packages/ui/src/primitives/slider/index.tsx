import { Slider as SliderPrimitive } from "@base-ui/react/slider"
import type { CSSProperties } from "react"

import { cn } from "../../lib/cn"

/**
 * A tick on the slider scale. The mark's `value` lives in the slider's own
 * value space (`min`..`max`), not in the consumer's units.
 */
export type SliderMark = {
  value: number
  disabled?: boolean
}

type SliderProps = SliderPrimitive.Root.Props & {
  /** Ticks drawn under the track at the given slider values. */
  marks?: readonly SliderMark[]
  /** Accessible value text for the thumb, computed from the slider value. */
  getAriaValueText?: (
    formattedValue: string,
    value: number,
    index: number,
  ) => string
}

function Slider({
  className,
  defaultValue,
  value,
  min = 0,
  max = 100,
  orientation = "horizontal",
  marks,
  getAriaValueText,
  ...props
}: SliderProps) {
  const _values = Array.isArray(value)
    ? value
    : Array.isArray(defaultValue)
      ? defaultValue
      : [min, max]

  const visibleMarks =
    orientation === "horizontal" && marks && marks.length > 0 ? marks : []
  const hasMarks = visibleMarks.length > 0
  const marksRange = max - min

  return (
    <SliderPrimitive.Root
      className={cn("data-horizontal:w-full data-vertical:h-full", className)}
      data-slot="slider"
      defaultValue={defaultValue}
      value={value}
      min={min}
      max={max}
      orientation={orientation}
      thumbAlignment="edge"
      {...props}
    >
      <SliderPrimitive.Control
        className={cn(
          "relative flex w-full touch-none items-center select-none data-disabled:opacity-50 data-vertical:h-full data-vertical:min-h-40 data-vertical:w-auto data-vertical:flex-col",
          hasMarks && "data-horizontal:h-11",
        )}
      >
        {hasMarks ? (
          <span
            aria-hidden
            data-slot="slider-marks"
            className="pointer-events-none absolute inset-0"
          >
            {visibleMarks.map((mark, index) => {
              const progress =
                marksRange > 0 ? (mark.value - min) / marksRange : 0
              if (!Number.isFinite(progress)) return null

              return (
                <span
                  key={`${mark.value}-${index}`}
                  data-slot="slider-mark"
                  data-value={mark.value}
                  data-disabled={mark.disabled ? "" : undefined}
                  className="slider-mark-position absolute top-1/2 h-6 w-0.5 -translate-x-1/2 -translate-y-1/2 rounded-full bg-border data-disabled:opacity-40"
                  style={
                    {
                      "--slider-mark-progress": progress,
                    } as CSSProperties
                  }
                />
              )
            })}
          </span>
        ) : null}
        <SliderPrimitive.Track
          data-slot="slider-track"
          className="relative grow overflow-hidden rounded-full bg-muted select-none data-horizontal:h-1 data-horizontal:w-full data-vertical:h-full data-vertical:w-1"
        >
          <SliderPrimitive.Indicator
            data-slot="slider-range"
            className="bg-primary select-none data-horizontal:h-full data-vertical:w-full"
          />
        </SliderPrimitive.Track>
        {Array.from({ length: _values.length }, (_, index) => (
          <SliderPrimitive.Thumb
            data-slot="slider-thumb"
            key={index}
            getAriaValueText={getAriaValueText}
            className={cn(
              "relative block shrink-0 rounded-full border border-ring bg-primary-foreground ring-ring/50 transition-[color,box-shadow] select-none after:absolute after:-inset-2 hover:ring-3 has-focus-visible:ring-3 focus-visible:ring-3 focus-visible:outline-hidden active:ring-3 disabled:pointer-events-none disabled:opacity-50",
              // `size-4.5` must match --slider-thumb-size in slider-mark-position.
              hasMarks ? "size-4.5" : "size-3",
            )}
          />
        ))}
      </SliderPrimitive.Control>
    </SliderPrimitive.Root>
  )
}

export { Slider }
