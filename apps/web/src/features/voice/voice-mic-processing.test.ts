import { describe, expect, it, vi, beforeEach } from 'vitest'

import { applyMicProcessing } from './voice-mic-processing'
import { voicePreferenceStore } from './voice-preference-store'

function participantWithAudioTrack(audioTrack: unknown) {
  return {
    getTrackPublication: vi.fn(() => ({ audioTrack })),
  }
}

describe('applyMicProcessing', () => {
  beforeEach(() => {
    voicePreferenceStore.setNoiseSuppression('browser')
    voicePreferenceStore.setVoiceGateEnabled(false)
    voicePreferenceStore.setVoiceGateThreshold(0.04)
  })

  it('stops custom mic processors without calling the removed legacy gate runtime', async () => {
    const audioTrack = {
      mediaStreamTrack: {
        applyConstraints: vi.fn(async () => {}),
      },
      getProcessor: vi.fn(() => null),
      stopProcessor: vi.fn(async () => {}),
      setProcessor: vi.fn(async () => {}),
    }

    await expect(
      applyMicProcessing(participantWithAudioTrack(audioTrack) as never),
    ).resolves.toBeUndefined()

    expect(audioTrack.stopProcessor).toHaveBeenCalledTimes(1)
    expect(audioTrack.setProcessor).not.toHaveBeenCalled()
    expect(audioTrack.mediaStreamTrack.applyConstraints).toHaveBeenCalledWith(
      expect.objectContaining({
        channelCount: 1,
        noiseSuppression: true,
      }),
    )
  })

  it('uses the LiveKit audio processor when voice gate is enabled', async () => {
    voicePreferenceStore.setVoiceGateEnabled(true)
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
    expect(audioTrack.stopProcessor).not.toHaveBeenCalled()
  })

  it('keeps browser noise suppression on the live track when enhanced mode is combined with gate', async () => {
    voicePreferenceStore.setNoiseSuppression('enhanced')
    voicePreferenceStore.setVoiceGateEnabled(true)
    const audioTrack = {
      mediaStreamTrack: {
        applyConstraints: vi.fn(async () => {}),
      },
      getProcessor: vi.fn(() => null),
      stopProcessor: vi.fn(async () => {}),
      setProcessor: vi.fn(async () => {}),
    }

    await applyMicProcessing(participantWithAudioTrack(audioTrack) as never)

    expect(audioTrack.mediaStreamTrack.applyConstraints).toHaveBeenCalledWith(
      expect.objectContaining({
        noiseSuppression: true,
      }),
    )
  })

  it('continues applying mic processors when live constraint updates are rejected', async () => {
    voicePreferenceStore.setVoiceGateEnabled(true)
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
