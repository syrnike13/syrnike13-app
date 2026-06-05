import { describe, expect, it } from 'vitest'

import {
  shouldShowVoiceInviteSlot,
  voiceStageGridContainerClass,
  voiceStageGridOuterClass,
  voiceStageGridSlotClass,
} from '#/components/voice/voice-stage-layout'

describe('voiceStageGrid layout', () => {
  it('centers the grid inside the stage area', () => {
    expect(voiceStageGridOuterClass).toContain('items-center')
    expect(voiceStageGridOuterClass).toContain('justify-center')
  })

  it('uses a two-column grid for three tiles on sm+', () => {
    expect(voiceStageGridContainerClass(3)).toContain('sm:grid-cols-2')
  })

  it('centers the last tile in a pyramid for odd counts', () => {
    expect(voiceStageGridSlotClass(3, 2)).toContain('sm:col-span-2')
    expect(voiceStageGridSlotClass(3, 2)).toContain('sm:justify-self-center')
  })

  it('does not pyramid even counts', () => {
    expect(voiceStageGridSlotClass(4, 3)).not.toContain('col-span-2')
  })

  it('sizes solo tile', () => {
    expect(voiceStageGridSlotClass(1, 0)).toContain('max-w-5xl')
  })
})

describe('shouldShowVoiceInviteSlot', () => {
  it('shows invite tile only when alone in voice', () => {
    expect(shouldShowVoiceInviteSlot(1)).toBe(true)
    expect(shouldShowVoiceInviteSlot(2)).toBe(false)
    expect(shouldShowVoiceInviteSlot(0)).toBe(false)
  })
})
