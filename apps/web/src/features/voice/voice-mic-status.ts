export type VoiceStatus = 'idle' | 'connecting' | 'connected'
export type VoiceConnectionPhase =
  | 'idle'
  | 'joining_channel'
  | 'fetching_rtc_token'
  | 'connecting_rtc'
  | 'connecting_microphone'
  | 'connected'
  | 'reconnecting'
  | 'failed'

import type { Translator } from '@syrnike13/ui/i18n'

const voiceConnectionPhaseKeys = {
  idle: 'idle',
  joining_channel: 'joiningChannel',
  fetching_rtc_token: 'fetchingToken',
  connecting_rtc: 'connectingRtc',
  connecting_microphone: 'connectingMic',
  connected: 'connected',
  reconnecting: 'reconnecting',
  failed: 'failed',
} as const satisfies Record<VoiceConnectionPhase, string>

export function voiceConnectionPhaseLabel(
  phase: VoiceConnectionPhase,
  t: Translator,
) {
  return t(voiceConnectionPhaseKeys[phase])
}

export function isVoiceSessionInChannel(
  voice: { channelId: string | null; status: VoiceStatus },
  channelId: string,
) {
  return (
    voice.channelId === channelId &&
    (voice.status === 'connected' || voice.status === 'connecting')
  )
}

export function isVoiceConnectionReady(options: {
  status: VoiceStatus
  localVoiceReady: boolean
}) {
  return options.status === 'connected' && options.localVoiceReady
}

export type VoiceMicIssue = {
  label: string
  hint: string
  retryable?: boolean
}

export function describeMicDeviceError(
  error: unknown,
  t: Translator,
): VoiceMicIssue {
  const name =
    error instanceof DOMException || error instanceof Error ? error.name : ''

  if (name === 'NotAllowedError' || name === 'PermissionDeniedError') {
    return {
      label: t('noAccessLabel'),
      hint: t('noAccessHint'),
    }
  }

  if (name === 'NotFoundError' || name === 'DevicesNotFoundError') {
    return {
      label: t('notFoundLabel'),
      hint: t('notFoundHint'),
    }
  }

  if (name === 'NotReadableError' || name === 'TrackStartError') {
    return {
      label: t('busyLabel'),
      hint: t('busyHint'),
    }
  }

  if (error instanceof Error && error.message.trim()) {
    return {
      label: t('unavailableLabel'),
      hint: error.message,
    }
  }

  return {
    label: t('unavailableLabel'),
    hint: t('unavailableHint'),
  }
}

export function micBlockedWithoutError(t: Translator): VoiceMicIssue {
  return {
    label: t('blockedLabel'),
    hint: t('blockedHint'),
  }
}

export function isMicVisuallyMuted(options: {
  inVoiceSession: boolean
  micEnabled: boolean
  micPublishing: boolean
  deafened: boolean
}) {
  if (options.deafened) {
    return true
  }
  if (options.inVoiceSession) {
    return !options.micPublishing
  }
  return !options.micEnabled
}

export function shouldResetMicPreferenceOnIssue(options: {
  wantsMic: boolean
  micPublishing: boolean
  micIssue: VoiceMicIssue | null
}) {
  return Boolean(
    options.micIssue &&
      options.micIssue.retryable !== true &&
      options.wantsMic &&
      !options.micPublishing,
  )
}
