import { describe, expect, it } from 'vitest'

import {
  shouldShowVoiceInviteSlot,
  voiceStageGridClass,
} from '#/components/voice/voice-stage-layout'

describe('voiceStageGridClass', () => {
  it('limits width for a solo participant', () => {
    expect(voiceStageGridClass(1)).toContain('max-w-3xl')
    expect(voiceStageGridClass(1)).toContain('grid-cols-1')
  })

  it('adds more columns as the room fills', () => {
    expect(voiceStageGridClass(5)).toContain('grid-cols-2')
    expect(voiceStageGridClass(10)).toContain('grid-cols-4')
  })
})

describe('shouldShowVoiceInviteSlot', () => {
  it('hides invite tile in large calls', () => {
    expect(shouldShowVoiceInviteSlot(3)).toBe(true)
    expect(shouldShowVoiceInviteSlot(5)).toBe(false)
  })
})
