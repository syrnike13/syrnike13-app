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
  it('hides invite tile in large calls', () => {
    expect(shouldShowVoiceInviteSlot(3)).toBe(true)
    expect(shouldShowVoiceInviteSlot(5)).toBe(false)
  })
})
