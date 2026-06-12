import type { VoiceCallState } from './voice-types'

export function voiceCallUiKey(call: VoiceCallState) {
  return `${call.channelId}:${call.initiatorId}:${String(call.startedAt)}`
}

export function isIncomingVoiceCall(
  call: VoiceCallState | undefined,
  currentUserId: string | undefined,
) {
  return Boolean(
    currentUserId &&
      call?.phase === 'ringing' &&
      call.initiatorId !== currentUserId &&
      call.recipients.includes(currentUserId),
  )
}

export function isVoiceCallDismissed(
  call: VoiceCallState | undefined,
  dismissedVoiceCallKeys: Record<string, true>,
) {
  return Boolean(call && dismissedVoiceCallKeys[voiceCallUiKey(call)])
}

export function isVoiceCallRingingDismissed(
  call: VoiceCallState | undefined,
  dismissedVoiceCallKeys: Record<string, true>,
) {
  return Boolean(
    call?.phase === 'ringing' &&
      isVoiceCallDismissed(call, dismissedVoiceCallKeys),
  )
}
