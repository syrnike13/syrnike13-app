import { beforeEach, describe, expect, it } from 'vitest'

import {
  createMicProcessorConfigFromPrefs,
  micProcessingNeeded,
  SYRNIKE_MIC_PROCESSOR_NAME,
  SyrnikeMicProcessor,
} from './voice-mic-processor'

describe('micProcessingNeeded', () => {
  it('is true when denoise, gate, or input gain is active', () => {
    expect(
      micProcessingNeeded({
        denoiseEnabled: true,
        gateEnabled: false,
        gateThresholdDb: -28,
        gateAutoThreshold: true,
        inputVolume: 1,
      }),
    ).toBe(true)

    expect(
      micProcessingNeeded({
        denoiseEnabled: false,
        gateEnabled: true,
        gateThresholdDb: -28,
        gateAutoThreshold: true,
        inputVolume: 1,
      }),
    ).toBe(true)

    expect(
      micProcessingNeeded({
        denoiseEnabled: false,
        gateEnabled: false,
        gateThresholdDb: -28,
        gateAutoThreshold: false,
        inputVolume: 1.5,
      }),
    ).toBe(true)
  })

  it('is false when all processing stages are off', () => {
    expect(
      micProcessingNeeded({
        denoiseEnabled: false,
        gateEnabled: false,
        gateThresholdDb: -28,
        gateAutoThreshold: true,
        inputVolume: 1,
      }),
    ).toBe(false)
  })
})

describe('createMicProcessorConfigFromPrefs', () => {
  it('maps voice preferences to processor config', () => {
    expect(
      createMicProcessorConfigFromPrefs({
        noiseSuppression: 'enhanced',
        voiceGateEnabled: true,
        voiceGateThresholdDb: -22,
        voiceGateAutoThreshold: true,
        inputVolume: 2,
      }),
    ).toEqual({
      denoiseEnabled: true,
      gateEnabled: true,
      gateThresholdDb: -22,
      gateAutoThreshold: true,
      gateStageOptions: {
        autoDynamic: true,
      },
      inputVolume: 2,
    })
  })
})

describe('SyrnikeMicProcessor', () => {
  it('uses the composite processor name', () => {
    const processor = new SyrnikeMicProcessor({
      denoiseEnabled: true,
      gateEnabled: true,
      gateThresholdDb: -28,
      gateAutoThreshold: true,
      inputVolume: 1,
    })

    expect(processor.name).toBe(SYRNIKE_MIC_PROCESSOR_NAME)
  })
})
