import { describe, expect, it } from 'vitest'

import { createVoiceRoomOptions } from './voice-capture'

describe('createVoiceRoomOptions', () => {
  it('captures microphone audio as mono voice', () => {
    const options = createVoiceRoomOptions()

    expect(options.audioCaptureDefaults?.channelCount).toBe(1)
  })
})
