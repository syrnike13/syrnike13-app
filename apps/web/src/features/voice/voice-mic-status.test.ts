import { describe, expect, it } from 'vitest'
import { createTranslator } from '@syrnike13/ui/i18n'

import ru from '#/messages/ru.json'
import {
  describeMicDeviceError,
  isVoiceConnectionReady,
  isMicVisuallyMuted,
  micBlockedWithoutError,
  shouldResetMicPreferenceOnIssue,
  voiceConnectionPhaseLabel,
} from '#/features/voice/voice-mic-status'

const tMic = createTranslator(ru, 'ru', 'voice.micIssue')
const tPhase = createTranslator(ru, 'ru', 'voice.status')
const blockedMicIssue = micBlockedWithoutError(tMic)

describe('describeMicDeviceError', () => {
  it('maps permission errors', () => {
    const issue = describeMicDeviceError(
      new DOMException('denied', 'NotAllowedError'),
      tMic,
    )
    expect(issue.label).toBe('Нет доступа к микрофону')
  })

  it('maps missing device errors', () => {
    const issue = describeMicDeviceError(
      new DOMException('missing', 'NotFoundError'),
      tMic,
    )
    expect(issue.label).toBe('Микрофон не найден')
  })
})

describe('isMicVisuallyMuted', () => {
  it('uses publishing state in voice', () => {
    expect(
      isMicVisuallyMuted({
        inVoiceSession: true,
        micEnabled: true,
        micPublishing: false,
        deafened: false,
      }),
    ).toBe(true)
  })

  it('uses preference outside voice', () => {
    expect(
      isMicVisuallyMuted({
        inVoiceSession: false,
        micEnabled: true,
        micPublishing: false,
        deafened: false,
      }),
    ).toBe(false)
  })

  it('shows an enabled microphone as muted while deafened', () => {
    expect(
      isMicVisuallyMuted({
        inVoiceSession: false,
        micEnabled: true,
        micPublishing: false,
        deafened: true,
      }),
    ).toBe(true)
  })

  it('restores an enabled microphone visual after undeafening', () => {
    expect(
      isMicVisuallyMuted({
        inVoiceSession: false,
        micEnabled: true,
        micPublishing: false,
        deafened: false,
      }),
    ).toBe(false)
  })

  it('keeps a disabled microphone visually muted after undeafening', () => {
    expect(
      isMicVisuallyMuted({
        inVoiceSession: false,
        micEnabled: false,
        micPublishing: false,
        deafened: false,
      }),
    ).toBe(true)
  })
})

describe('isVoiceConnectionReady', () => {
  it('waits for local voice setup after the LiveKit room connects', () => {
    expect(
      isVoiceConnectionReady({
        status: 'connected',
        localVoiceReady: false,
      }),
    ).toBe(false)
  })

  it('reports ready when the room and local voice setup are both ready', () => {
    expect(
      isVoiceConnectionReady({
        status: 'connected',
        localVoiceReady: true,
      }),
    ).toBe(true)
  })
})

describe('voiceConnectionPhaseLabel', () => {
  it('uses specific connection stage labels', () => {
    expect(voiceConnectionPhaseLabel('joining_channel', tPhase)).toBe(
      'Подключение к каналу…',
    )
    expect(voiceConnectionPhaseLabel('fetching_rtc_token', tPhase)).toBe(
      'Получение RTC-сессии…',
    )
    expect(voiceConnectionPhaseLabel('connecting_rtc', tPhase)).toBe(
      'Подключение к RTC…',
    )
    expect(voiceConnectionPhaseLabel('connecting_microphone', tPhase)).toBe(
      'Подключение голосового потока…',
    )
    expect(voiceConnectionPhaseLabel('connected', tPhase)).toBe(
      'Голос подключён',
    )
  })
})

describe('micBlockedWithoutError', () => {
  it('has fallback copy', () => {
    expect(blockedMicIssue.label.length).toBeGreaterThan(0)
  })
})

describe('shouldResetMicPreferenceOnIssue', () => {
  it('resets desired mic state when an enabled mic cannot publish', () => {
    expect(
      shouldResetMicPreferenceOnIssue({
        wantsMic: true,
        micPublishing: false,
        micIssue: blockedMicIssue,
      }),
    ).toBe(true)
  })

  it('keeps preference when there is no active mic issue', () => {
    expect(
      shouldResetMicPreferenceOnIssue({
        wantsMic: true,
        micPublishing: false,
        micIssue: null,
      }),
    ).toBe(false)
  })

  it('preserves user intent for retryable native runtime failures', () => {
    expect(
      shouldResetMicPreferenceOnIssue({
        wantsMic: true,
        micPublishing: false,
        micIssue: {
          label: 'Микрофон временно недоступен',
          hint: 'Track publication timed out',
          retryable: true,
        },
      }),
    ).toBe(false)
  })
})
