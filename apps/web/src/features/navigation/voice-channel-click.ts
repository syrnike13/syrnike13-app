export type VoiceChannelClickAction = 'open' | 'join-and-open'

export type VoiceChannelClickVoiceStatus = 'idle' | 'connecting' | 'connected'

export type VoiceChannelClickState = {
  clickedChannelId: string
  currentRouteChannelId?: string
  voiceChannelId: string | null
  voiceStatus: VoiceChannelClickVoiceStatus
}

export function resolveVoiceChannelClickAction(
  state: VoiceChannelClickState,
): VoiceChannelClickAction {
  const voiceSessionActive =
    state.voiceStatus === 'connecting' || state.voiceStatus === 'connected'
  const clickedVoiceSessionActive =
    voiceSessionActive && state.voiceChannelId === state.clickedChannelId

  if (clickedVoiceSessionActive) {
    return 'open'
  }

  if (voiceSessionActive && state.voiceChannelId) {
    return 'join-and-open'
  }

  return 'join-and-open'
}
