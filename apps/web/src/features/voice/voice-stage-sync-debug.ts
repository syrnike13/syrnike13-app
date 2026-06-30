import type { NativeMediaState } from '#/features/voice/native-media-coordinator'
import type { VoiceDebugAgentPayload } from '#/features/voice/voice-debug-agent-log'

export type StageSyncScreenStateDebug = {
  nativeScreenState: NativeMediaState['screen']['status']
  nativeScreenVisible?: boolean
  remoteParticipants: number
  nativeScreenParticipants: number
  nativeScreenPublications: number
  nativeScreenPublicationPresent: boolean | null
  tracks: number
  screenItems: number
  localScreenItems: number
  localScreenLive: boolean
}

export function stageSyncScreenStateDebugKey(
  state: StageSyncScreenStateDebug,
) {
  return JSON.stringify({
    nativeScreenState: state.nativeScreenState,
    nativeScreenVisible: state.nativeScreenVisible,
    remoteParticipants: state.remoteParticipants,
    nativeScreenParticipants: state.nativeScreenParticipants,
    nativeScreenPublications: state.nativeScreenPublications,
    nativeScreenPublicationPresent: state.nativeScreenPublicationPresent,
    tracks: state.tracks,
    screenItems: state.screenItems,
    localScreenItems: state.localScreenItems,
  })
}

export function shouldLogStageSyncScreenStateDebug(
  state: StageSyncScreenStateDebug,
) {
  return (
    state.nativeScreenState !== 'idle' ||
    state.nativeScreenParticipants > 0 ||
    state.screenItems > 0
  )
}

export function stageSyncScreenStateDebugPayload(
  state: StageSyncScreenStateDebug,
): VoiceDebugAgentPayload {
  return {
    hypothesis: 'H3-stage-native-screen-loss',
    event: 'stage-sync-screen-state',
    ...state,
  }
}
