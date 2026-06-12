"use client"

import * as React from "react"
import { Slider as SliderPrimitive } from "radix-ui"

import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "#/components/ui/tooltip"
import { cn } from "#/lib/utils.ts"

export type SliderCheckpoint = {
  value: number
  label?: React.ReactNode
}

/** @deprecated Use SliderCheckpoint */
export type SliderMark = SliderCheckpoint

type SliderProps = React.ComponentPropsWithoutRef<typeof SliderPrimitive.Root> & {
  showTooltip?: boolean
  tooltipContent?: (value: number) => React.ReactNode
  checkpoints?: SliderCheckpoint[]
  checkpointStep?: number
  checkpointLabel?: (value: number) => React.ReactNode
  /** @deprecated Use checkpoints */
  marks?: SliderCheckpoint[]
}

function valueToPercent(value: number, min: number, max: number) {
  if (max <= min) return 0
  return ((value - min) / (max - min)) * 100
}

function buildCheckpoints(
  min: number,
  max: number,
  checkpointStep: number | undefined,
  checkpoints: SliderCheckpoint[] | undefined,
  checkpointLabel: ((value: number) => React.ReactNode) | undefined,
): SliderCheckpoint[] {
  if (checkpoints?.length) return checkpoints
  if (checkpointStep == null || checkpointStep <= 0 || max <= min) return []
  const values: number[] = []
  for (let value = min; value <= max; value += checkpointStep) {
    values.push(value)
  }
  return values.map((value) => ({
    value,
    label: checkpointLabel ? checkpointLabel(value) : value,
  }))
}

function checkpointHorizontalStyle(percent: number): React.CSSProperties {
  if (percent <= 0) {
    return { left: "0%" }
  }
  if (percent >= 100) {
    return { left: "100%", transform: "translateX(-100%)" }
  }
  return { left: `${percent}%`, transform: "translateX(-50%)" }
}

const Slider = React.forwardRef<
  React.ElementRef<typeof SliderPrimitive.Root>,
  SliderProps
>(
  (
    {
      className,
      defaultValue,
      value,
      min = 0,
      max = 100,
      step,
      showTooltip = true,
      tooltipContent,
      checkpoints,
      checkpointStep,
      checkpointLabel,
      marks,
      onValueChange,
      ...props
    },
    ref,
  ) => {
    const thumbCount = React.useMemo(() => {
      if (Array.isArray(value)) return value.length
      if (Array.isArray(defaultValue)) return defaultValue.length
      return 1
    }, [defaultValue, value])

    const [tooltipOpen, setTooltipOpen] = React.useState(false)
    const [internalValue, setInternalValue] = React.useState<number[]>(() => {
      if (Array.isArray(value)) return value
      if (Array.isArray(defaultValue)) return defaultValue
      return [min]
    })

    React.useEffect(() => {
      if (value !== undefined) {
        setInternalValue(value)
      }
    }, [value])

    const handlePointerUp = React.useCallback(() => {
      setTooltipOpen(false)
    }, [])

    React.useEffect(() => {
      if (!showTooltip) return
      document.addEventListener("pointerup", handlePointerUp)
      return () => {
        document.removeEventListener("pointerup", handlePointerUp)
      }
    }, [handlePointerUp, showTooltip])

    const handleValueChange = (nextValue: number[]) => {
      setInternalValue(nextValue)
      onValueChange?.(nextValue)
    }

    const checkpointItems = React.useMemo(
      () =>
        buildCheckpoints(
          min,
          max,
          checkpointStep,
          checkpoints ?? marks,
          checkpointLabel,
        ),
      [checkpointLabel, checkpointStep, checkpoints, marks, max, min],
    )

    const renderThumb = (thumbValue: number, index: number) => {
      const thumb = (
        <SliderPrimitive.Thumb
          data-slot="slider-thumb"
          className="block size-5 shrink-0 rounded-full border-2 border-foreground bg-foreground transition-colors focus-visible:outline-hidden disabled:pointer-events-none disabled:opacity-50"
          onPointerDown={() => {
            if (showTooltip) setTooltipOpen(true)
          }}
        />
      )

      if (!showTooltip) {
        return <React.Fragment key={index}>{thumb}</React.Fragment>
      }

      return (
        <Tooltip key={index} open={tooltipOpen}>
          <TooltipTrigger asChild>{thumb}</TooltipTrigger>
          <TooltipContent sideOffset={8} className="px-2 py-1 text-xs">
            {tooltipContent ? tooltipContent(thumbValue) : thumbValue}
          </TooltipContent>
        </Tooltip>
      )
    }

    const hasCheckpoints = checkpointItems.length > 0

    return (
      <div className={cn("w-full", className)}>
        <TooltipProvider delayDuration={0}>
          <div
            className={cn(
              "relative w-full",
              hasCheckpoints && "pt-4",
            )}
          >
            <div className="relative flex h-5 w-full items-center">
              {hasCheckpoints
                ? checkpointItems.map((checkpoint) => {
                    const percent = valueToPercent(checkpoint.value, min, max)
                    return (
                      <div
                        key={checkpoint.value}
                        className="pointer-events-none absolute top-1/2 z-0 -translate-y-1/2"
                        style={checkpointHorizontalStyle(percent)}
                        aria-hidden
                      >
                        <div className="relative flex flex-col items-center">
                          <span className="absolute bottom-full left-1/2 mb-1.5 -translate-x-1/2 whitespace-nowrap text-[11px] leading-none text-muted-foreground tabular-nums">
                            {checkpoint.label ?? checkpoint.value}
                          </span>
                          <span className="h-6 w-0.5 rounded-full bg-foreground/40" />
                        </div>
                      </div>
                    )
                  })
                : null}

              <SliderPrimitive.Root
                ref={ref}
                data-slot="slider"
                defaultValue={defaultValue}
                value={value}
                min={min}
                max={max}
                step={step}
                className="relative z-10 flex w-full touch-none items-center select-none data-[disabled]:opacity-50 data-[orientation=vertical]:h-full data-[orientation=vertical]:min-h-44 data-[orientation=vertical]:w-auto data-[orientation=vertical]:flex-col"
                onPointerDown={() => {
                  if (showTooltip) setTooltipOpen(true)
                }}
                onValueChange={handleValueChange}
                {...props}
              >
                <SliderPrimitive.Track
                  data-slot="slider-track"
                  className="relative grow overflow-hidden rounded-full bg-foreground/40 data-[orientation=horizontal]:h-1.5 data-[orientation=horizontal]:w-full data-[orientation=vertical]:h-full data-[orientation=vertical]:w-1.5"
                >
                  <SliderPrimitive.Range
                    data-slot="slider-range"
                    className="absolute bg-primary data-[orientation=horizontal]:h-full data-[orientation=vertical]:w-full"
                  />
                </SliderPrimitive.Track>
                {Array.from({ length: thumbCount }, (_, index) =>
                  renderThumb(internalValue[index] ?? min, index),
                )}
              </SliderPrimitive.Root>
            </div>
          </div>
        </TooltipProvider>
      </div>
    )
  },
)
Slider.displayName = SliderPrimitive.Root.displayName

export { Slider }
