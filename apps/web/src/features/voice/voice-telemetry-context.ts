import { createContext, useContext } from 'react'

import type { VoicePingSample } from '#/features/voice/voice-ping-history'
import type { RtcDebugSnapshot } from '#/features/voice/voice-rtc-debug'

export type VoiceTelemetryContextValue = {
  /** RTT до LiveKit в мс; null пока нет замера. */
  voicePingMs: number | null
  /** История замеров для графика в поповере подключения. */
  voicePingHistory: readonly VoicePingSample[]
  rtcDebugEnabled: boolean
  setRtcDebugEnabled: (enabled: boolean) => void
  rtcDebugSnapshot: RtcDebugSnapshot | null
  rtcDebugHistory: readonly RtcDebugSnapshot[]
}

export const VoiceTelemetryContext =
  createContext<VoiceTelemetryContextValue | null>(null)

export function useVoiceTelemetry() {
  const context = useContext(VoiceTelemetryContext)
  if (!context) {
    throw new Error('useVoiceTelemetry must be used within VoiceProvider')
  }
  return context
}
