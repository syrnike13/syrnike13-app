import { describe, expect, it } from 'vitest'

import {
  shouldShowVoiceInviteSlot,
  voiceStageGridClass,
} from '#/components/voice/voice-stage-layout'

describe('voiceStageGridClass', () => {
  it('keeps a solo tile able to fill the stage', () => {
    expect(voiceStageGridClass(1)).toContain('grid-cols-1')
    expect(voiceStageGridClass(1)).not.toContain('max-w-')
  })

  it('adds more columns as the room fills', () => {
    expect(voiceStageGridClass(5)).toContain('md:grid-cols-3')
    expect(voiceStageGridClass(10)).toContain('grid-cols-4')
    expect(voiceStageGridClass(10)).not.toContain('max-w-')
  })
})

describe('shouldShowVoiceInviteSlot', () => {
  it('shows invite tile only when alone in voice', () => {
    expect(shouldShowVoiceInviteSlot(1)).toBe(true)
    expect(shouldShowVoiceInviteSlot(2)).toBe(false)
    expect(shouldShowVoiceInviteSlot(0)).toBe(false)
  })
})
