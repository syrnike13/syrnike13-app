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

export type VoiceCallState = {
  channelId: string
  initiatorId: string
  phase: 'ringing' | 'active'
  startedAt: number | string
  expiresAt?: number | string
  recipients: string[]
  declinedRecipients: string[]
}

/** channelId → userId → state */
export type VoiceParticipantsByChannel = Record<
  string,
  Record<string, UserVoiceState>
>

/** channelId -> call state */
export type VoiceCallsByChannel = Record<string, VoiceCallState>
