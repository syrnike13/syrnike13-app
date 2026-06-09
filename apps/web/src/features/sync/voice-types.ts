/** Состояние участника голосового канала (протокол WS v1). */
export type UserVoiceState = {
  id: string
  joined_at: number
  self_mute: boolean
  self_deaf: boolean
  server_muted: boolean
  server_deafened: boolean
  screensharing: boolean
  camera: boolean
  version: number
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
