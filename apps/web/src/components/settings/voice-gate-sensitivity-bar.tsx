import { useEffect, useRef, type PointerEvent, type RefObject } from 'react'
import { useTranslations } from '@syrnike13/ui/i18n'

import type { VoiceGateMetrics } from '#/features/voice/voice-gate-stage'
import {
  formatGateThresholdDb,
  gateDbToPosition,
  positionToGateDb,
  VOICE_GATE_DB_MAX,
  VOICE_GATE_DB_MIN,
} from '#/features/voice/voice-gate-level'
import type { CSSVars } from '#/lib/css-vars'
import { cn } from '#/lib/utils'

type VoiceGateSensitivityBarProps = {
  metricsRef: RefObject<VoiceGateMetrics>
  thresholdDb: number
  auto: boolean
  onThresholdChange: (thresholdDb: number) => void
}

function positionFromClientX(clientX: number, rect: DOMRect) {
  return Math.min(1, Math.max(0, (clientX - rect.left) / rect.width))
}

export function VoiceGateSensitivityBar({
  metricsRef,
  thresholdDb,
  auto,
  onThresholdChange,
}: VoiceGateSensitivityBarProps) {
  const t = useTranslations('settings.voice')
  const trackRef = useRef<HTMLDivElement | null>(null)
  const levelRef = useRef<HTMLDivElement | null>(null)
  const markerRef = useRef<HTMLDivElement | null>(null)
  const labelRef = useRef<HTMLSpanElement | null>(null)
  const draggingRef = useRef(false)
  const displayInputDb = useRef(VOICE_GATE_DB_MIN)
  const displayThresholdDb = useRef(thresholdDb)

  useEffect(() => {
    displayThresholdDb.current = thresholdDb
  }, [thresholdDb])

  useEffect(() => {
    let frame = 0
    const tick = () => {
      const metrics = metricsRef.current
      if (metrics) {
        displayInputDb.current =
          displayInputDb.current * 0.72 + metrics.inputDb * 0.28
        if (auto) {
          displayThresholdDb.current =
            displayThresholdDb.current * 0.9 + metrics.thresholdDb * 0.1
        }
      }

      const inputPos = gateDbToPosition(displayInputDb.current)
      const thresholdPos = gateDbToPosition(
        auto ? displayThresholdDb.current : thresholdDb,
      )

      if (levelRef.current) {
        levelRef.current.style.setProperty(
          '--level-width',
          `${inputPos * 100}%`,
        )
      }
      if (markerRef.current) {
        markerRef.current.style.setProperty(
          '--marker-left',
          `${thresholdPos * 100}%`,
        )
      }
      if (labelRef.current) {
        labelRef.current.textContent = formatGateThresholdDb(
          auto ? displayThresholdDb.current : thresholdDb,
        )
      }

      frame = requestAnimationFrame(tick)
    }

    frame = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(frame)
  }, [auto, metricsRef, thresholdDb])

  const setThresholdFromPointer = (clientX: number) => {
    const track = trackRef.current
    if (!track || auto) return
    onThresholdChange(
      positionToGateDb(positionFromClientX(clientX, track.getBoundingClientRect())),
    )
  }

  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (auto) return
    draggingRef.current = true
    event.currentTarget.setPointerCapture(event.pointerId)
    setThresholdFromPointer(event.clientX)
  }

  const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    if (!draggingRef.current || auto) return
    setThresholdFromPointer(event.clientX)
  }

  const onPointerUp = (event: PointerEvent<HTMLDivElement>) => {
    if (!draggingRef.current) return
    draggingRef.current = false
    event.currentTarget.releasePointerCapture(event.pointerId)
  }

  return (
    <div className="flex flex-col gap-1.5">
      {/* eslint-disable-next-line design/no-lookalike -- drag track of the gate threshold */}
      <div
        ref={trackRef}
        role="slider"
        aria-valuemin={VOICE_GATE_DB_MIN}
        aria-valuemax={VOICE_GATE_DB_MAX}
        aria-valuenow={thresholdDb}
        aria-label={t('gateAria')}
        aria-disabled={auto}
        className={cn(
          'relative flex h-3.5 items-center',
          !auto && 'cursor-pointer',
        )}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
      >
        {/* Same geometry as Slider: 6px track, primary fill, 14px thumb. */}
        <div className="relative h-1.5 w-full overflow-hidden rounded-full bg-foreground/20">
          <div
            ref={levelRef}
            className="absolute inset-y-0 left-0 w-(--level-width) rounded-full bg-primary"
            style={{ '--level-width': '0%' } as CSSVars}
          />
        </div>
        <div
          ref={markerRef}
          className={cn(
            'absolute top-1/2 left-(--marker-left) size-3.5 -translate-1/2 rounded-full border-2 border-primary bg-background',
            auto && 'opacity-60',
          )}
          style={{ '--marker-left': '0%' } as CSSVars}
        />
      </div>
      <div className="flex items-center justify-between text-xs text-muted-foreground tabular-nums">
        <span>{VOICE_GATE_DB_MIN} dB</span>
        <span>
          {t('gateThreshold', {
            value: formatGateThresholdDb(thresholdDb),
          })}
          {auto ? t('gateAuto') : ''}
        </span>
        <span>{VOICE_GATE_DB_MAX} dB</span>
      </div>
    </div>
  )
}
