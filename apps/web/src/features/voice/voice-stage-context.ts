import {
  createContext,
  useContext,
  type Dispatch,
  type SetStateAction,
} from 'react'

import type { VoiceStageMediaItem } from '#/features/voice/voice-context'
import type { StageMediaFilters } from '#/features/voice/voice-stage-media'

export type VoiceStageContextValue = {
  /** Канал RTC-сессии, для которой построены stageMediaItems. */
  stageChannelId: string | null
  stageMediaItems: readonly VoiceStageMediaItem[]
  focusedMediaId: string | null
  setFocusedMediaId: (mediaId: string | null) => void
  /** Увеличивается при запросе фокуса стрима со stage. */
  stageFocusNonce: number
  watchParticipantScreenShare: (
    channelId: string,
    userId: string,
  ) => Promise<void>
  stageMediaFilters: StageMediaFilters
  setStageMediaFilters: Dispatch<SetStateAction<StageMediaFilters>>
  setStageMediaSubscribed: (mediaId: string, subscribed: boolean) => void
  stageFullscreen: boolean
  toggleStageFullscreen: () => void
  activityLauncherOpen: boolean
  setActivityLauncherOpen: Dispatch<SetStateAction<boolean>>
}

export const VoiceStageContext = createContext<VoiceStageContextValue | null>(
  null,
)

export function useVoiceStage() {
  const context = useContext(VoiceStageContext)
  if (!context) {
    throw new Error('useVoiceStage must be used within VoiceProvider')
  }
  return context
}
