import { useCallback, useMemo, useRef, useState } from 'react'

import {
  formatVoicePingChartTime,
  formatVoicePingChartTimeDetailed,
  voicePingChartDomain,
  type VoicePingSample,
} from '#/features/voice/voice-ping-history'
import { cn } from '#/lib/utils'

const WIDTH = 288
const HEIGHT = 112
const PAD = { top: 8, right: 28, bottom: 22, left: 4 }
const PLOT_W = WIDTH - PAD.left - PAD.right
const PLOT_H = HEIGHT - PAD.top - PAD.bottom

type VoicePingChartProps = {
  history: readonly VoicePingSample[]
  className?: string
}

type ChartPoint = {
  index: number
  x: number
  y: number
  ms: number
  timestamp: number
  label: string
}

export function VoicePingChart({ history, className }: VoicePingChartProps) {
  const svgRef = useRef<SVGSVGElement>(null)
  const [activeIndex, setActiveIndex] = useState<number | null>(null)
  const model = useMemo(() => buildChartModel(history), [history])

  const pickNearestPoint = useCallback(
    (clientX: number) => {
      if (model.points.length === 0 || !svgRef.current) return

      const rect = svgRef.current.getBoundingClientRect()
      const svgX = ((clientX - rect.left) / rect.width) * WIDTH
      let nearest = 0
      let nearestDistance = Number.POSITIVE_INFINITY

      for (const point of model.points) {
        const distance = Math.abs(point.x - svgX)
        if (distance < nearestDistance) {
          nearestDistance = distance
          nearest = point.index
        }
      }

      setActiveIndex(nearest)
    },
    [model.points],
  )

  if (model.points.length === 0) {
    return (
      <div
        className={cn(
          'flex h-28 items-center justify-center rounded-md bg-muted/40 text-xs text-muted-foreground',
          className,
        )}
      >
        Собираем данные…
      </div>
    )
  }

  const { polyline, yTicks, xTicks, yMin, yMax, points } = model
  const activePoint =
    activeIndex == null
      ? null
      : (points.find((point) => point.index === activeIndex) ?? null)
  const tooltipLeft =
    activePoint == null
      ? 50
      : Math.min(92, Math.max(8, (activePoint.x / WIDTH) * 100))

  return (
    <div className={cn('relative h-28', className)}>
      <svg
        ref={svgRef}
        viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
        className="h-full w-full cursor-crosshair text-muted-foreground"
        role="img"
        aria-label="График пинга"
        onMouseLeave={() => setActiveIndex(null)}
      >
        {yTicks.map((tick) => {
          const y = scalePingY(tick, yMin, yMax)
          return (
            <g key={tick}>
              <line
                x1={PAD.left}
                x2={PAD.left + PLOT_W}
                y1={y}
                y2={y}
                className="stroke-border/60"
                strokeWidth={1}
              />
              <text
                x={WIDTH - 4}
                y={y + 3}
                textAnchor="end"
                className="fill-muted-foreground text-[9px]"
              >
                {tick}
              </text>
            </g>
          )
        })}

        <polyline
          fill="none"
          className="stroke-chart-4"
          strokeWidth={2}
          strokeLinejoin="round"
          strokeLinecap="round"
          points={polyline}
        />

        {activePoint ? (
          <>
            <line
              x1={activePoint.x}
              x2={activePoint.x}
              y1={PAD.top}
              y2={PAD.top + PLOT_H}
              className="stroke-chart-4/50"
              strokeWidth={1}
              strokeDasharray="3 3"
            />
            <circle
              cx={activePoint.x}
              cy={activePoint.y}
              r={4}
              className="fill-chart-4 stroke-background"
              strokeWidth={2}
            />
          </>
        ) : null}

        {xTicks.map((tick) => (
          <text
            key={tick.timestamp}
            x={tick.x}
            y={HEIGHT - 4}
            textAnchor="middle"
            className="fill-muted-foreground text-[9px]"
          >
            {tick.label}
          </text>
        ))}

        <rect
          x={PAD.left}
          y={PAD.top}
          width={PLOT_W}
          height={PLOT_H}
          fill="transparent"
          onMouseMove={(event) => pickNearestPoint(event.clientX)}
          onMouseEnter={(event) => pickNearestPoint(event.clientX)}
        />
      </svg>

      {activePoint ? (
        <div
          className="gradient-surface-floating pointer-events-none absolute top-1 z-10 -translate-x-1/2 rounded-md border border-border bg-popover px-2 py-1 text-xs text-popover-foreground shadow-md"
          style={{ left: `${tooltipLeft}%` }}
        >
          <p className="font-semibold tabular-nums">{activePoint.ms} мс</p>
          <p className="text-[10px] text-muted-foreground">{activePoint.label}</p>
        </div>
      ) : null}
    </div>
  )
}

function scalePingY(ms: number, yMin: number, yMax: number) {
  const span = Math.max(yMax - yMin, 1)
  const clamped = Math.min(yMax, Math.max(yMin, ms))
  return PAD.top + (1 - (clamped - yMin) / span) * PLOT_H
}

function buildChartModel(history: readonly VoicePingSample[]) {
  if (history.length === 0) {
    return {
      points: [] as ChartPoint[],
      polyline: '',
      yMin: 0,
      yMax: 100,
      yTicks: [0, 50, 100],
      xTicks: [] as Array<{ timestamp: number; x: number; label: string }>,
    }
  }

  const { yMin, yMax, yTicks } = voicePingChartDomain(history)
  const start = history[0]!.timestamp
  const end = history[history.length - 1]!.timestamp
  const span = Math.max(end - start, 1)

  const points: ChartPoint[] = history.map((sample, index) => {
    const x = PAD.left + ((sample.timestamp - start) / span) * PLOT_W
    const y = scalePingY(sample.ms, yMin, yMax)
    return {
      index,
      x,
      y,
      ms: sample.ms,
      timestamp: sample.timestamp,
      label: formatVoicePingChartTimeDetailed(sample.timestamp),
    }
  })

  const polyline = points.map((point) => `${point.x},${point.y}`).join(' ')

  const tickCount = Math.min(4, history.length)
  const xTicks = Array.from({ length: tickCount }, (_, index) => {
    const sampleIndex =
      tickCount === 1
        ? 0
        : Math.round((index / (tickCount - 1)) * (history.length - 1))
    const sample = history[sampleIndex]!
    const x = PAD.left + ((sample.timestamp - start) / span) * PLOT_W
    return {
      timestamp: sample.timestamp,
      x,
      label: formatVoicePingChartTime(sample.timestamp),
    }
  })

  return { points, polyline, yMin, yMax, yTicks, xTicks }
}
