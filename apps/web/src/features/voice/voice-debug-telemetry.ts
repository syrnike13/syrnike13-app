import { useCallback, useEffect, useRef, useState } from 'react'
import type { Room } from 'livekit-client'

import {
  appendVoicePingSample,
  type VoicePingSample,
} from '#/features/voice/voice-ping-history'
import { measureVoicePingMs } from '#/features/voice/voice-ping'
import {
  appendRtcDebugSample,
  collectVoiceRtcDebugSnapshot,
  deriveRtcRates,
  type RtcDebugSnapshot,
  type RtcDebugStageMediaItem,
} from '#/features/voice/voice-rtc-debug'
import { rtcDebugScreenSlice } from '#/features/voice/voice-screen-share'
import { logVoiceDebugAgent } from '#/features/voice/voice-debug-agent-log'
import type { VoiceStatus } from '#/features/voice/voice-mic-status'
import type { VoiceStageMediaItem } from '#/features/voice/voice-context'
import type { MutableRef } from '#/features/voice/voice-types'

export type VoiceTelemetryDebugOptions = {
  status: VoiceStatus
  roomRef: MutableRef<Room | null>
  stageMediaItemsRef: MutableRef<VoiceStageMediaItem[]>
}

export function useVoiceTelemetryDebug({
  status,
  roomRef,
  stageMediaItemsRef,
}: VoiceTelemetryDebugOptions) {
  const rtcDebugSnapshotRef = useRef<RtcDebugSnapshot | null>(null)
  const screenShareDebugUntilRef = useRef(0)
  const [voicePingMs, setVoicePingMs] = useState<number | null>(null)
  const [voicePingHistory, setVoicePingHistory] = useState<VoicePingSample[]>(
    [],
  )
  const [rtcDebugEnabled, setRtcDebugEnabled] = useState(false)
  const [rtcDebugSnapshot, setRtcDebugSnapshot] =
    useState<RtcDebugSnapshot | null>(null)
  const [rtcDebugHistory, setRtcDebugHistory] = useState<RtcDebugSnapshot[]>([])
  const [screenShareDebugRun, setScreenShareDebugRun] = useState(0)

  const resetVoiceTelemetryDebugState = useCallback(() => {
    setVoicePingMs(null)
    setVoicePingHistory([])
    rtcDebugSnapshotRef.current = null
    setRtcDebugSnapshot(null)
    setRtcDebugHistory([])
    screenShareDebugUntilRef.current = 0
    setScreenShareDebugRun(0)
  }, [])

  useEffect(() => {
    if (status !== 'connected') {
      setVoicePingMs(null)
      setVoicePingHistory([])
      return
    }

    const room = roomRef.current
    if (!room) return
    const activeRoom: Room = room

    let active = true

    async function samplePing() {
      const ping = await measureVoicePingMs(activeRoom)
      if (!active) return
      setVoicePingMs(ping)
      if (ping != null) {
        setVoicePingHistory((history) =>
          appendVoicePingSample(history, {
            timestamp: Date.now(),
            ms: ping,
          }),
        )
      }
    }

    void samplePing()
    const interval = window.setInterval(() => void samplePing(), 2000)

    return () => {
      active = false
      window.clearInterval(interval)
    }
  }, [roomRef, status])

  useEffect(() => {
    if (status !== 'connected') {
      rtcDebugSnapshotRef.current = null
      setRtcDebugSnapshot(null)
      setRtcDebugHistory([])
      return
    }
    if (!rtcDebugEnabled) return

    const room = roomRef.current
    if (!room) return
    const activeRoom: Room = room

    let active = true

    async function sampleRtcDebug() {
      try {
        const current = await collectVoiceRtcDebugSnapshot(
          activeRoom,
          stageMediaItemsRef.current as RtcDebugStageMediaItem[],
        )
        if (!active) return

        const previous = rtcDebugSnapshotRef.current
        const snapshot: RtcDebugSnapshot = previous
          ? {
              ...current,
              rates: deriveRtcRates(previous, current),
            }
          : current

        rtcDebugSnapshotRef.current = snapshot
        setRtcDebugSnapshot(snapshot)
        setRtcDebugHistory((history) =>
          appendRtcDebugSample(history, snapshot),
        )
      } catch {
        if (!active) return
        rtcDebugSnapshotRef.current = null
        setRtcDebugSnapshot(null)
      }
    }

    void sampleRtcDebug()
    const interval = window.setInterval(() => void sampleRtcDebug(), 1000)

    return () => {
      active = false
      window.clearInterval(interval)
    }
  }, [roomRef, rtcDebugEnabled, stageMediaItemsRef, status])

  useEffect(() => {
    if (status !== 'connected') return
    if (screenShareDebugRun === 0) return

    const room = roomRef.current
    if (!room) return
    const activeRoom: Room = room

    let active = true
    let interval: number | null = null

    async function sampleScreenShareDebug() {
      if (Date.now() > screenShareDebugUntilRef.current) {
        if (interval != null) {
          window.clearInterval(interval)
          interval = null
        }
        return
      }
      try {
        const snapshot = await collectVoiceRtcDebugSnapshot(
          activeRoom,
          stageMediaItemsRef.current as RtcDebugStageMediaItem[],
        )
        if (!active) return
        logVoiceDebugAgent({
          hypothesis: 'H2-bitrate-ramp,H3-remote-decode-lag',
          event: 'rtc-screen-sample',
          ...rtcDebugScreenSlice(snapshot),
        })
      } catch (error) {
        if (!active) return
        logVoiceDebugAgent({
          hypothesis: 'H2-bitrate-ramp,H3-remote-decode-lag',
          event: 'rtc-screen-sample-failed',
          message: error instanceof Error ? error.message : String(error),
        })
      }
    }

    void sampleScreenShareDebug()
    interval = window.setInterval(
      () => void sampleScreenShareDebug(),
      1000,
    )

    return () => {
      active = false
      if (interval != null) {
        window.clearInterval(interval)
      }
    }
  }, [
    roomRef,
    screenShareDebugRun,
    screenShareDebugUntilRef,
    stageMediaItemsRef,
    status,
  ])

  return {
    voicePingMs,
    voicePingHistory,
    rtcDebugEnabled,
    setRtcDebugEnabled,
    rtcDebugSnapshot,
    rtcDebugHistory,
    screenShareDebugUntilRef,
    setScreenShareDebugRun,
    resetVoiceTelemetryDebugState,
  }
}
