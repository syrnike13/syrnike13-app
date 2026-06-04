import { describe, expect, it } from 'vitest'

import {
  describeMicDeviceError,
  isMicVisuallyMuted,
  MIC_BLOCKED_WITHOUT_ERROR,
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

describe('MIC_BLOCKED_WITHOUT_ERROR', () => {
  it('has fallback copy', () => {
    expect(MIC_BLOCKED_WITHOUT_ERROR.label.length).toBeGreaterThan(0)
  })
})
