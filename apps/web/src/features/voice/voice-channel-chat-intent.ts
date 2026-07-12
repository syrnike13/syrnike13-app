type VoiceChannelChatOpenListener = (channelId: string) => void

let pendingOpenChannelId: string | null = null
const listeners = new Set<VoiceChannelChatOpenListener>()

export function requestVoiceChannelChatOpen(channelId: string) {
  pendingOpenChannelId = channelId
  for (const listener of listeners) {
    listener(channelId)
  }
}

export function consumeVoiceChannelChatOpenRequest(channelId: string): boolean {
  if (pendingOpenChannelId !== channelId) return false
  pendingOpenChannelId = null
  return true
}

export function subscribeVoiceChannelChatOpen(
  listener: VoiceChannelChatOpenListener,
): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}
