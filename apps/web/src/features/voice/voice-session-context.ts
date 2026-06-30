import { createContext, useContext } from 'react'

import type {
  VoiceConnectionPhase,
  VoiceStatus,
} from '#/features/voice/voice-mic-status'

export type VoiceSessionContextValue = {
  channelId: string | null
  status: VoiceStatus
  connectionPhase: VoiceConnectionPhase
  /** LiveKit room connected and local media setup finished. */
  localVoiceReady: boolean
  /** Намерение пользователя: микрофон включён. */
  micEnabled: boolean
  /** Фактическая публикация микрофона в LiveKit. */
  micPublishing: boolean
  deafened: boolean
  participantCount: number
  speakingUserIds: ReadonlySet<string>
  join: (channelId: string) => Promise<boolean>
  leave: () => void
  toggleMic: () => void
  toggleDeafen: () => void
}

export const VoiceSessionContext =
  createContext<VoiceSessionContextValue | null>(null)

export function useVoiceSession() {
  const context = useContext(VoiceSessionContext)
  if (!context) {
    throw new Error('useVoiceSession must be used within VoiceProvider')
  }
  return context
}
