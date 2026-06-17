export type VoiceChannelClickAction = 'open' | 'join'

export type VoiceChannelClickVoiceStatus = 'idle' | 'connecting' | 'connected'

export type VoiceChannelClickState = {
  clickedChannelId: string
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

  return 'join'
}
