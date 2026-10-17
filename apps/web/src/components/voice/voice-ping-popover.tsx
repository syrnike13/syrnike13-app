import { useEffect, useState } from 'react'
import { Link } from '@tanstack/react-router'
import { Effect, Fiber } from 'effect'
import { useTranslations, type Translator } from '@syrnike13/ui/i18n'

import { buttonVariants } from '@syrnike13/ui/primitives/button'
import { VoicePingChart } from '#/components/voice/voice-ping-chart'
import {
  PopoverContent,
  PopoverHeader,
  PopoverTitle,
} from '@syrnike13/ui/primitives/popover'
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
  const t = useTranslations('voice')
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
      className={cn('w-voice-ping-popover p-0', className)}
    >
      <PopoverHeader className="gap-0 border-b px-3 py-2.5">
        <PopoverTitle className="text-sm font-semibold text-primary">
          {t('ping.connection')}
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
            <p className="text-xs text-muted-foreground">
              {t('ping.quality')}
            </p>
            <p className="mt-0.5 text-sm font-semibold text-foreground">
              {qualityLabel(quality, t)}
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
            label={t('ping.average')}
            value={formatPingMs(averageMs, t)}
          />
          <PingStatRow
            label={t('ping.last')}
            value={formatPingMs(lastDisplay, t)}
          />
          <PingStatRow
            label={t('ping.packetLoss')}
            value={formatRtcPercent(rates?.quality.packetLossPercent)}
          />
          <PingStatRow
            label={t('ping.jitter')}
            value={formatRtcMs(rates?.quality.jitterMs)}
          />
          <PingStatRow
            label={t('ping.incoming')}
            value={formatRtcBitrate(rates?.transport.inboundBitrate)}
          />
          <PingStatRow
            label={t('ping.outgoing')}
            value={formatRtcBitrate(rates?.transport.outboundBitrate)}
          />
        </dl>

        <p className="text-xs leading-relaxed text-muted-foreground">
          {t('ping.footnote')}
        </p>

        <Link
          to="/app/voice-debug"
          className={cn(
            buttonVariants({ variant: 'secondary', size: 'sm' }),
            'w-full',
          )}
        >
          {t('ping.debug')}
        </Link>
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

function formatPingMs(ms: number | null, t: Translator) {
  if (ms == null) return '—'
  return t('ping.ms', { ms })
}

function qualityLabel(quality: RtcConnectionQuality, t: Translator) {
  if (quality === 'good') return t('ping.good')
  if (quality === 'fair') return t('ping.fair')
  if (quality === 'poor') return t('ping.poor')
  return t('ping.collecting')
}
