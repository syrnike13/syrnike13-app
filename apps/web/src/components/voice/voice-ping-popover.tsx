import { useEffect, useState } from 'react'
import { Link } from '@tanstack/react-router'

import { Button } from '#/components/ui/button'
import { VoicePingChart } from '#/components/voice/voice-ping-chart'
import {
  PopoverContent,
  PopoverHeader,
  PopoverTitle,
} from '#/components/ui/popover'
import { summarizeVoicePingHistory } from '#/features/voice/voice-ping-history'
import { resolveVoiceNodeName } from '#/features/voice/voice-node'
import { useVoice } from '#/features/voice/voice-provider'
import { cn } from '#/lib/utils'

type VoicePingPopoverContentProps = {
  className?: string
}

export function VoicePingPopoverContent({
  className,
}: VoicePingPopoverContentProps) {
  const voice = useVoice()
  const [nodeName, setNodeName] = useState<string | null>(null)

  useEffect(() => {
    let active = true
    void resolveVoiceNodeName().then((name) => {
      if (active) setNodeName(name)
    })
    return () => {
      active = false
    }
  }, [])

  const { averageMs, lastMs } = summarizeVoicePingHistory(voice.voicePingHistory)
  const lastDisplay = voice.voicePingMs ?? lastMs

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
          <VoicePingChart history={voice.voicePingHistory} />
        </div>

        {nodeName ? (
          <p className="truncate text-sm font-semibold text-foreground">
            {nodeName}
          </p>
        ) : null}

        <dl className="space-y-1.5 text-sm">
          <PingStatRow
            label="Средний пинг"
            value={formatPingMs(averageMs)}
          />
          <PingStatRow
            label="Последний пинг"
            value={formatPingMs(lastDisplay)}
          />
        </dl>

        <p className="text-xs leading-relaxed text-muted-foreground">
          Задержка звука может быть заметна при пинге от 250 мс и выше.
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
    <div className="flex items-baseline justify-between gap-3">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="font-semibold tabular-nums text-foreground">{value}</dd>
    </div>
  )
}

function formatPingMs(ms: number | null) {
  if (ms == null) return '—'
  return `${ms} мс`
}
