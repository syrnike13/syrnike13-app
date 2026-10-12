import { useEffect, useState } from 'react'
import { Link } from '@tanstack/react-router'
import { Effect, Fiber } from 'effect'

import { Button } from '#/components/ui/button'
import { VoicePingChart } from '#/components/voice/voice-ping-chart'
import {
  PopoverContent,
  PopoverHeader,
  PopoverTitle,
} from '#/components/ui/popover'
import { summarizeVoicePingHistory } from '#/features/voice/voice-ping-history'
import { resolveVoiceNodeNameEffect } from '#/features/voice/voice-node'
import {
  formatRtcBitrate,
  formatRtcMs,
  formatRtcPercent,
  rtcConnectionQuality,
  type RtcConnectionQuality,
} from '#/features/voice/voice-rtc-debug'
import { useVoiceTelemetry } from '#/features/voice/voice-telemetry-context'
import { cn } from '#/lib/utils'

type VoicePingPopoverContentProps = {
  className?: string
}

export function VoicePingPopoverContent({
  className,
}: VoicePingPopoverContentProps) {
  const voiceTelemetry = useVoiceTelemetry()
  const [nodeName, setNodeName] = useState<string | null>(null)

  useEffect(() => {
    const fiber = Effect.runFork(
      resolveVoiceNodeNameEffect.pipe(
        Effect.tap((name) =>
          Effect.sync(() => {
            setNodeName(name)
          }),
        ),
      ),
    )
    return () => {
      Effect.runFork(Fiber.interrupt(fiber))
    }
  }, [])

  const { averageMs, lastMs } = summarizeVoicePingHistory(
    voiceTelemetry.voicePingHistory,
  )
  const lastDisplay = voiceTelemetry.voicePingMs ?? lastMs
  const snapshot = voiceTelemetry.rtcDebugSnapshot
  const quality = rtcConnectionQuality(snapshot)
  const rates = snapshot?.rates

  return (
    <PopoverContent
      side="top"
      align="start"
      sideOffset={8}
      className={cn('w-[min(20rem,calc(100vw-2rem))] p-0', className)}
    >
      <PopoverHeader className="gap-0 border-b px-3 py-2.5">
        <PopoverTitle className="text-sm font-semibold text-primary">
          Подключение
        </PopoverTitle>
        <div className="mt-2 h-0.5 w-full rounded-full bg-border">
          <div className="h-full w-1/3 rounded-full bg-primary" />
        </div>
      </PopoverHeader>

      <div className="space-y-3 px-3 py-3">
        <div className="rounded-md bg-muted/35 px-1 py-1">
          <VoicePingChart history={voiceTelemetry.voicePingHistory} />
        </div>

        {nodeName ? (
          <p className="truncate text-sm font-semibold text-foreground">
            {nodeName}
          </p>
        ) : null}

        <div className="flex items-center justify-between gap-3 rounded-md border border-border bg-card px-3 py-2">
          <div>
            <p className="text-xs text-muted-foreground">Качество соединения</p>
            <p className="mt-0.5 text-sm font-semibold text-foreground">
              {qualityLabel(quality)}
            </p>
          </div>
          <span
            className={cn(
              'size-2.5 rounded-full',
              quality === 'good' && 'bg-primary',
              quality === 'fair' && 'bg-chart-4',
              quality === 'poor' && 'bg-destructive',
              quality === 'unknown' && 'bg-muted-foreground',
            )}
            aria-hidden
          />
        </div>

        <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm">
          <PingStatRow
            label="Средний пинг"
            value={formatPingMs(averageMs)}
          />
          <PingStatRow
            label="Последний пинг"
            value={formatPingMs(lastDisplay)}
          />
          <PingStatRow
            label="Потери пакетов"
            value={formatRtcPercent(rates?.quality.packetLossPercent)}
          />
          <PingStatRow
            label="Джиттер"
            value={formatRtcMs(rates?.quality.jitterMs)}
          />
          <PingStatRow
            label="Входящий поток"
            value={formatRtcBitrate(rates?.transport.inboundBitrate)}
          />
          <PingStatRow
            label="Исходящий поток"
            value={formatRtcBitrate(rates?.transport.outboundBitrate)}
          />
        </dl>

        <p className="text-xs leading-relaxed text-muted-foreground">
          Потери, джиттер и скрытые аудиосэмплы рассчитываются по изменению
          WebRTC-счётчиков между замерами.
        </p>

        <Button asChild variant="secondary" size="sm" className="w-full">
          <Link to="/app/voice-debug">Отладка RTC</Link>
        </Button>
      </div>
    </PopoverContent>
  )
}

function PingStatRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0">
      <dt className="truncate text-xs text-muted-foreground">{label}</dt>
      <dd className="mt-0.5 truncate font-semibold tabular-nums text-foreground">
        {value}
      </dd>
    </div>
  )
}

function formatPingMs(ms: number | null) {
  if (ms == null) return '—'
  return `${ms} мс`
}

function qualityLabel(quality: RtcConnectionQuality) {
  if (quality === 'good') return 'Хорошее'
  if (quality === 'fair') return 'Нестабильное'
  if (quality === 'poor') return 'Плохое'
  return 'Собираем данные'
}
