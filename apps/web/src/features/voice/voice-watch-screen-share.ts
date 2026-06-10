import type { VoiceStatus } from '#/features/voice/voice-mic-status'

export function isVoiceConnectedInChannel(
  voice: { channelId: string | null; status: VoiceStatus },
  channelId: string,
) {
  return voice.channelId === channelId && voice.status === 'connected'
}

export function isRemoteScreenShareSubscribed(
  mediaId: string,
  watchedRemoteScreenIds: ReadonlySet<string>,
) {
  return watchedRemoteScreenIds.has(mediaId)
}
