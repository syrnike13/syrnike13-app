import { describe, expect, it } from 'vitest'

import { clampInlineVoiceStageHeight } from '#/components/chat/channel-view'

describe('clampInlineVoiceStageHeight', () => {
  it('keeps voice stage within container bounds', () => {
    expect(clampInlineVoiceStageHeight(100, 800)).toBe(220)
    expect(clampInlineVoiceStageHeight(500, 800)).toBe(500)
    expect(clampInlineVoiceStageHeight(900, 800)).toBe(640)
  })
})
