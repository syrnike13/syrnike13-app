import { beforeEach, describe, expect, it } from 'vitest'

import { createVoiceRoomOptions } from './voice-capture'
import { voicePreferenceStore } from './voice-preference-store'

describe('createVoiceRoomOptions', () => {
  beforeEach(() => {
    voicePreferenceStore.setNoiseSuppression('browser')
    voicePreferenceStore.setVoiceGateEnabled(false)
  })

  it('captures microphone audio as mono voice', () => {
    const options = createVoiceRoomOptions()

    expect(options.audioCaptureDefaults?.channelCount).toBe(1)
  })

  it('keeps browser noise suppression for enhanced mode when voice gate owns mic processing', () => {
    voicePreferenceStore.setNoiseSuppression('enhanced')
    voicePreferenceStore.setVoiceGateEnabled(true)

    const options = createVoiceRoomOptions()

    expect(options.audioCaptureDefaults?.noiseSuppression).toBe(true)
  })

  it('keeps enhanced mode free of browser noise suppression when the enhanced processor can run', () => {
    voicePreferenceStore.setNoiseSuppression('enhanced')
    voicePreferenceStore.setVoiceGateEnabled(false)

    const options = createVoiceRoomOptions()

    expect(options.audioCaptureDefaults?.noiseSuppression).toBe(false)
  })
})
