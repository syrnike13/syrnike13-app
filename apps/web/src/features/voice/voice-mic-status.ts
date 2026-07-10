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

const voiceConnectionPhaseLabels = {
  idle: 'Не подключён',
  joining_channel: 'Подключение к каналу…',
  fetching_rtc_token: 'Получение RTC-сессии…',
  connecting_rtc: 'Подключение к RTC…',
  connecting_microphone: 'Подключение голосового потока…',
  connected: 'Голос подключён',
  reconnecting: 'Переподключение к голосу…',
  failed: 'Ошибка подключения',
} as const satisfies Record<VoiceConnectionPhase, string>

export function voiceConnectionPhaseLabel(phase: VoiceConnectionPhase) {
  return voiceConnectionPhaseLabels[phase]
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

export function describeMicDeviceError(error: unknown): VoiceMicIssue {
  const name =
    error instanceof DOMException || error instanceof Error ? error.name : ''

  if (name === 'NotAllowedError' || name === 'PermissionDeniedError') {
    return {
      label: 'Нет доступа к микрофону',
      hint: 'Разрешите доступ к микрофону в настройках браузера для syrnike13.ru.',
    }
  }

  if (name === 'NotFoundError' || name === 'DevicesNotFoundError') {
    return {
      label: 'Микрофон не найден',
      hint: 'Подключите микрофон или выберите другое устройство в настройках.',
    }
  }

  if (name === 'NotReadableError' || name === 'TrackStartError') {
    return {
      label: 'Микрофон занят',
      hint: 'Закройте другие вкладки, профили Chrome или программы, которые используют микрофон.',
    }
  }

  if (error instanceof Error && error.message.trim()) {
    return {
      label: 'Микрофон недоступен',
      hint: error.message,
    }
  }

  return {
    label: 'Микрофон недоступен',
    hint: 'Не удалось включить микрофон. Проверьте разрешения и устройство.',
  }
}

export const MIC_BLOCKED_WITHOUT_ERROR: VoiceMicIssue = {
  label: 'Микрофон не работает',
  hint: 'Браузер не передал звук с микрофона. Проверьте разрешения и другие вкладки или профили Chrome.',
}

export function isMicVisuallyMuted(options: {
  inVoiceSession: boolean
  micEnabled: boolean
  micPublishing: boolean
}) {
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

export function micControlTitle(options: {
  inVoice: boolean
  micMuted: boolean
  micIssue: VoiceMicIssue | null
}) {
  if (options.micIssue) {
    return options.micIssue.hint
  }
  if (options.inVoice) {
    return options.micMuted ? 'Включить микрофон' : 'Выключить микрофон'
  }
  return options.micMuted
    ? 'Микрофон выключен (применится при входе в голос)'
    : 'Выключить микрофон до входа в голос'
}
