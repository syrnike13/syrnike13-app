import { describe, expect, it } from 'vitest'

import {
  describeMicDeviceError,
  isVoiceConnectionReady,
  isMicVisuallyMuted,
  MIC_BLOCKED_WITHOUT_ERROR,
  shouldResetMicPreferenceOnIssue,
  voiceConnectionPhaseLabel,
} from '#/features/voice/voice-mic-status'

describe('describeMicDeviceError', () => {
  it('maps permission errors', () => {
    const issue = describeMicDeviceError(
      new DOMException('denied', 'NotAllowedError'),
    )
    expect(issue.label).toBe('Нет доступа к микрофону')
  })

  it('maps missing device errors', () => {
    const issue = describeMicDeviceError(
      new DOMException('missing', 'NotFoundError'),
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
      }),
    ).toBe(true)
  })

  it('uses preference outside voice', () => {
    expect(
      isMicVisuallyMuted({
        inVoiceSession: false,
        micEnabled: true,
        micPublishing: false,
      }),
    ).toBe(false)
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
    expect(voiceConnectionPhaseLabel('joining_channel')).toBe(
      'Подключение к каналу…',
    )
    expect(voiceConnectionPhaseLabel('fetching_rtc_token')).toBe(
      'Получение RTC-сессии…',
    )
    expect(voiceConnectionPhaseLabel('connecting_rtc')).toBe(
      'Подключение к RTC…',
    )
    expect(voiceConnectionPhaseLabel('connecting_microphone')).toBe(
      'Подключение голосового потока…',
    )
    expect(voiceConnectionPhaseLabel('connected')).toBe('Голос подключён')
  })
})

describe('MIC_BLOCKED_WITHOUT_ERROR', () => {
  it('has fallback copy', () => {
    expect(MIC_BLOCKED_WITHOUT_ERROR.label.length).toBeGreaterThan(0)
  })
})

describe('shouldResetMicPreferenceOnIssue', () => {
  it('resets desired mic state when an enabled mic cannot publish', () => {
    expect(
      shouldResetMicPreferenceOnIssue({
        wantsMic: true,
        micPublishing: false,
        micIssue: MIC_BLOCKED_WITHOUT_ERROR,
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
