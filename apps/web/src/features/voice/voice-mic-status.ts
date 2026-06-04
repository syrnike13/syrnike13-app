export type VoiceStatus = 'idle' | 'connecting' | 'connected'

export function isVoiceSessionInChannel(
  voice: { channelId: string | null; status: VoiceStatus },
  channelId: string,
) {
  return (
    voice.channelId === channelId &&
    (voice.status === 'connected' || voice.status === 'connecting')
  )
}

export type VoiceMicIssue = {
  label: string
  hint: string
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
      hint: 'Закройте другие программы, которые используют микрофон.',
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
  hint: 'Браузер не передал доступ к микрофону. Проверьте разрешения сайта.',
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
