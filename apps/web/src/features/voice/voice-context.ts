import {
  createContext,
  useContext,
  type Dispatch,
  type SetStateAction,
} from 'react'
import type { Track, VideoTrack } from 'livekit-client'

import type {
  VoiceConnectionPhase,
  VoiceMicIssue,
  VoiceStatus,
} from '#/features/voice/voice-mic-status'
import type { VoicePingSample } from '#/features/voice/voice-ping-history'
import type { RtcDebugSnapshot } from '#/features/voice/voice-rtc-debug'
import type {
  StageMediaFilters,
  StageMediaItem,
} from '#/features/voice/voice-stage-media'

export type VoiceStageMediaPublication = {
  source: Track.Source
  track?: Track | null
  isMuted?: boolean
  isSubscribed?: boolean
  setSubscribed?: (subscribed: boolean) => void
  options?: {
    videoCodec?: string
    simulcast?: boolean
    degradationPreference?: string
    screenShareEncoding?: {
      maxBitrate?: number
      maxFramerate?: number
    }
  }
}

export type VoiceStageMediaItem = StageMediaItem<
  VideoTrack,
  VoiceStageMediaPublication
>

export type VoiceContextValue = {
  channelId: string | null
  status: VoiceStatus
  connectionPhase: VoiceConnectionPhase
  /** LiveKit room connected and local media setup finished. */
  localVoiceReady: boolean
  /** Намерение пользователя: микрофон включён. */
  micEnabled: boolean
  /** Фактическая публикация микрофона в LiveKit. */
  micPublishing: boolean
  /** Причина, если микрофон хотели включить, но он недоступен. */
  micIssue: VoiceMicIssue | null
  deafened: boolean
  participantCount: number
  speakingUserIds: ReadonlySet<string>
  /** RTT до LiveKit в мс; null пока нет замера. */
  voicePingMs: number | null
  /** История замеров для графика в поповере подключения. */
  voicePingHistory: readonly VoicePingSample[]
  rtcDebugEnabled: boolean
  setRtcDebugEnabled: (enabled: boolean) => void
  rtcDebugSnapshot: RtcDebugSnapshot | null
  rtcDebugHistory: readonly RtcDebugSnapshot[]
  cameraEnabled: boolean
  screenShareEnabled: boolean
  screenShareStarting: boolean
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
  join: (channelId: string) => Promise<void>
  leave: () => void
  toggleMic: () => void
  toggleDeafen: () => void
  toggleCamera: () => void
  toggleScreenShare: () => void
  setSelfMonitoringActive: (active: boolean) => void
  /** Трек активной native mic-сессии для превью в настройках без второго захвата. */
  getNativeMicrophonePreviewTrack: () => MediaStreamTrack | null
}

export const VoiceContext = createContext<VoiceContextValue | null>(null)

export function useVoice() {
  const context = useContext(VoiceContext)
  if (!context) {
    throw new Error('useVoice must be used within VoiceProvider')
  }
  return context
}
