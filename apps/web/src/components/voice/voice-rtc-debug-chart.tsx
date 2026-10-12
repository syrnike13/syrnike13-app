import { useId } from 'react'

import { cn } from '#/lib/utils'

type RtcDebugMetricChartProps<T> = {
  history: readonly T[]
  value: (sample: T) => number | null | undefined
  className?: string
}

export function RtcDebugMetricChart<T>({
  history,
  value,
  className,
}: RtcDebugMetricChartProps<T>) {
  const gridPatternId = `rtc-debug-grid-${useId().replace(/:/g, '')}`
  const points = history
    .map((sample) => value(sample))
    .filter((sample): sample is number => sample != null && Number.isFinite(sample))

  if (points.length < 2) {
    return (
      <div
        className={cn(
          'h-20 border-t border-border bg-muted/35',
          className,
        )}
      >
        <ChartGrid patternId={gridPatternId} />
      </div>
    )
  }

  const min = Math.min(...points)
  const max = Math.max(...points)
  const span = Math.max(max - min, 1)
  const path = points
    .map((point, index) => {
      const x = (index / Math.max(points.length - 1, 1)) * 100
      const y = 90 - ((point - min) / span) * 80
      return `${index === 0 ? 'M' : 'L'} ${x.toFixed(2)} ${y.toFixed(2)}`
    })
    .join(' ')

  return (
    <div
      className={cn(
        'h-20 border-t border-border bg-muted/35',
        className,
      )}
    >
      <svg viewBox="0 0 100 100" preserveAspectRatio="none" className="size-full">
        <defs>
          <pattern id={gridPatternId} width="25" height="50" patternUnits="userSpaceOnUse">
            <path
              d="M 25 0 L 0 0 0 50"
              fill="none"
              className="stroke-border/60"
              strokeWidth="0.6"
            />
          </pattern>
        </defs>
        <rect width="100" height="100" fill={`url(#${gridPatternId})`} />
        <path
          d={path}
          fill="none"
          className="stroke-primary"
          strokeWidth="1.8"
          vectorEffect="non-scaling-stroke"
        />
      </svg>
    </div>
  )
}

function ChartGrid({ patternId }: { patternId: string }) {
  return (
    <svg
      viewBox="0 0 100 100"
      preserveAspectRatio="none"
      className="size-full"
      aria-hidden
    >
      <defs>
        <pattern id={patternId} width="25" height="50" patternUnits="userSpaceOnUse">
          <path
            d="M 25 0 L 0 0 0 50"
            fill="none"
            className="stroke-border/60"
            strokeWidth="0.6"
          />
        </pattern>
      </defs>
      <rect width="100" height="100" fill={`url(#${patternId})`} />
    </svg>
  )
}
