import { describe, expect, it, vi, beforeEach } from 'vitest'

import { applyMicProcessing } from './voice-mic-processing'
import { SYRNIKE_MIC_PROCESSOR_NAME } from './voice-mic-processor'
import { voicePreferenceStore } from './voice-preference-store'

function participantWithAudioTrack(audioTrack: unknown) {
  return {
    getTrackPublication: vi.fn(() => ({ audioTrack })),
  }
}

describe('applyMicProcessing', () => {
  beforeEach(() => {
    voicePreferenceStore.setVoiceGateEnabled(true)
    voicePreferenceStore.setVoiceGateThresholdDb(-28)
    voicePreferenceStore.setInputVolume(1)
  })

  it('applies the composite mic processor with gate enabled', async () => {
    const audioTrack = {
      mediaStreamTrack: {
        applyConstraints: vi.fn(async () => {}),
      },
      getProcessor: vi.fn(() => null),
      stopProcessor: vi.fn(async () => {}),
      setProcessor: vi.fn(async () => {}),
    }

    await applyMicProcessing(participantWithAudioTrack(audioTrack) as never)

    expect(audioTrack.setProcessor).toHaveBeenCalledTimes(1)
    expect(audioTrack.setProcessor.mock.calls[0]?.[0]?.name).toBe(
      SYRNIKE_MIC_PROCESSOR_NAME,
    )
    expect(audioTrack.mediaStreamTrack.applyConstraints).toHaveBeenCalledWith(
      expect.objectContaining({
        channelCount: 1,
        noiseSuppression: false,
        autoGainControl: false,
      }),
    )
  })

  it('still applies the processor when only gate remains active', async () => {
    voicePreferenceStore.setInputVolume(1)

    const audioTrack = {
      mediaStreamTrack: {
        applyConstraints: vi.fn(async () => {}),
      },
      getProcessor: vi.fn(() => null),
      stopProcessor: vi.fn(async () => {}),
      setProcessor: vi.fn(async () => {}),
    }

    await applyMicProcessing(participantWithAudioTrack(audioTrack) as never)

    expect(audioTrack.setProcessor).toHaveBeenCalledTimes(1)
  })

  it('continues applying mic processors when live constraint updates are rejected', async () => {
    const audioTrack = {
      mediaStreamTrack: {
        applyConstraints: vi.fn(async () => {
          throw new Error('unsupported constraint')
        }),
      },
      getProcessor: vi.fn(() => null),
      stopProcessor: vi.fn(async () => {}),
      setProcessor: vi.fn(async () => {}),
    }

    await expect(
      applyMicProcessing(participantWithAudioTrack(audioTrack) as never),
    ).resolves.toBeUndefined()

    expect(audioTrack.setProcessor).toHaveBeenCalledTimes(1)
  })
})
