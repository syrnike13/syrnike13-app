import { describe, expect, it } from 'vitest'

import { shouldShowVoiceInviteSlot } from '#/components/voice/voice-stage-layout'

describe('shouldShowVoiceInviteSlot', () => {
  it('shows invite tile only when alone in voice', () => {
    expect(shouldShowVoiceInviteSlot(1)).toBe(true)
    expect(shouldShowVoiceInviteSlot(2)).toBe(false)
    expect(shouldShowVoiceInviteSlot(0)).toBe(false)
  })
})
