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
  const points = history
    .map((sample) => value(sample))
    .filter((sample): sample is number => sample != null && Number.isFinite(sample))

  if (points.length < 2) {
    return (
      <div
        className={cn(
          'h-20 border-t border-[#292b31] bg-[#1f2025]/35',
          className,
        )}
      >
        <div className="h-full w-full bg-[linear-gradient(to_right,rgba(255,255,255,0.025)_1px,transparent_1px),linear-gradient(to_bottom,rgba(255,255,255,0.025)_1px,transparent_1px)] bg-[size:25%_100%,100%_50%]" />
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
        'h-20 border-t border-[#292b31] bg-[#1f2025]/35',
        className,
      )}
    >
      <svg viewBox="0 0 100 100" preserveAspectRatio="none" className="size-full">
        <defs>
          <pattern id="rtc-debug-grid" width="25" height="50" patternUnits="userSpaceOnUse">
            <path d="M 25 0 L 0 0 0 50" fill="none" stroke="rgba(255,255,255,0.035)" strokeWidth="0.6" />
          </pattern>
        </defs>
        <rect width="100" height="100" fill="url(#rtc-debug-grid)" />
        <path d={path} fill="none" stroke="#5865f2" strokeWidth="1.8" vectorEffect="non-scaling-stroke" />
      </svg>
    </div>
  )
}
