import { useEffect, useRef, type PointerEvent, type RefObject } from 'react'

import type { VoiceGateMetrics } from '#/features/voice/voice-gate-stage'
import {
  formatGateThresholdDb,
  gateDbToPosition,
  positionToGateDb,
  VOICE_GATE_DB_MAX,
  VOICE_GATE_DB_MIN,
} from '#/features/voice/voice-gate-level'
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
  const trackRef = useRef<HTMLDivElement | null>(null)
  const levelRef = useRef<HTMLDivElement | null>(null)
  const markerRef = useRef<HTMLDivElement | null>(null)
  const labelRef = useRef<HTMLSpanElement | null>(null)
  const draggingRef = useRef(false)
  const displayInputDb = useRef(VOICE_GATE_DB_MIN)
  const displayThresholdDb = useRef(thresholdDb)
  const lastAgentLogAt = useRef(0)

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

      const now = Date.now()
      if (now - lastAgentLogAt.current > 1000) {
        lastAgentLogAt.current = now
        const debugData = {
          metricsInputDb: metrics?.inputDb ?? null,
          displayInputDb: displayInputDb.current,
          inputPos,
          thresholdDb: auto ? displayThresholdDb.current : thresholdDb,
          thresholdPos,
          auto,
        }
        console.info('[gate-preview-debug]', 'sensitivity bar rendered metrics', debugData)
      }

      if (levelRef.current) {
        levelRef.current.style.width = `${inputPos * 100}%`
      }
      if (markerRef.current) {
        markerRef.current.style.left = `${thresholdPos * 100}%`
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
    <div className="space-y-1.5">
      <div
        ref={trackRef}
        role="slider"
        aria-valuemin={VOICE_GATE_DB_MIN}
        aria-valuemax={VOICE_GATE_DB_MAX}
        aria-valuenow={thresholdDb}
        aria-label="Порог гейта микрофона"
        aria-disabled={auto}
        className={cn(
          'relative h-2 overflow-hidden rounded-full bg-muted',
          !auto && 'cursor-pointer',
        )}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
      >
        <div
          ref={levelRef}
          className="absolute inset-y-0 left-0 rounded-full bg-primary/80"
          style={{ width: '0%' }}
        />
        <div
          ref={markerRef}
          className="absolute inset-y-0 z-10 w-px -translate-x-1/2 bg-foreground/90"
          style={{ left: '0%' }}
        />
      </div>
      <div className="flex items-center justify-between text-[11px] text-muted-foreground tabular-nums">
        <span>{VOICE_GATE_DB_MIN} dB</span>
        <span>
          Порог: <span ref={labelRef}>{formatGateThresholdDb(thresholdDb)}</span>
          {auto ? ' · авто' : ''}
        </span>
        <span>{VOICE_GATE_DB_MAX} dB</span>
      </div>
    </div>
  )
}
