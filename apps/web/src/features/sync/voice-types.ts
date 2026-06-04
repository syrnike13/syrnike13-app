/** Состояние участника голосового канала (протокол WS v1). */
export type UserVoiceState = {
  id: string
  joined_at: number
  is_receiving: boolean
  is_publishing: boolean
  screensharing: boolean
  camera: boolean
}

export type ChannelVoiceState = {
  id: string
  participants: UserVoiceState[]
}

/** channelId → userId → state */
export type VoiceParticipantsByChannel = Record<
  string,
  Record<string, UserVoiceState>
>
