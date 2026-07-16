import { createContext, useContext } from 'react'

import type { VoiceMediaAvailabilityState } from '#/features/voice/voice-media-availability'
import type { VoiceMicIssue } from '#/features/voice/voice-mic-status'

export type VoiceMediaContextValue = {
  /** Причина, если микрофон хотели включить, но он недоступен. */
  micIssue: VoiceMicIssue | null
  /** Доступность микрофона, камеры и демонстрации на текущем устройстве. */
  mediaAvailability: VoiceMediaAvailabilityState
  cameraEnabled: boolean
  screenShareEnabled: boolean
  screenShareStarting: boolean
  toggleCamera: () => void
  toggleScreenShare: () => void
  setSelfMonitoringActive: (active: boolean) => void
  /** Трек активной native mic-сессии для превью в настройках без второго захвата. */
  getNativeMicrophonePreviewTrack: () => MediaStreamTrack | null
}

export const VoiceMediaContext =
  createContext<VoiceMediaContextValue | null>(null)

export function useVoiceMedia() {
  const context = useContext(VoiceMediaContext)
  if (!context) {
    throw new Error('useVoiceMedia must be used within VoiceProvider')
  }
  return context
}
