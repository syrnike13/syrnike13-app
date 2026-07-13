import { describe, expectTypeOf, it } from 'vitest'

import type { SyrnikeDesktopApi } from './api'
import type { NativeMediaStatsEvent, NativeMicrophonePipelineConfig } from './media'

describe('native media support contracts', () => {
  it('keeps the microphone pipeline command config for runtime users', () => {
    expectTypeOf<NativeMicrophonePipelineConfig>().toMatchTypeOf<{
      deviceId: string | null
      noiseSuppression: boolean
      echoCancellation: boolean
      inputVolume: number
      voiceGateEnabled: boolean
      voiceGateThresholdDb: number
      voiceGateAutoThreshold: boolean
    }>()
  })

  it('keeps internal native session stats typed', () => {
    expectTypeOf<NativeMediaStatsEvent>().toMatchTypeOf<{
      sessionId: string
      methods: { wgc_gpu: number; dxgi_gpu: number }
    }>()
  })

  it('exposes only renderer-owned media support operations', () => {
    type DesktopMediaApi = SyrnikeDesktopApi['media']
    expectTypeOf<DesktopMediaApi>().toHaveProperty('startMicrophonePreview')
    expectTypeOf<DesktopMediaApi>().toHaveProperty('setRemoteVideoDemand')
    expectTypeOf<DesktopMediaApi>().not.toHaveProperty('applyLocalMediaIntent')
    expectTypeOf<DesktopMediaApi>().not.toHaveProperty('configureMicrophonePipeline')
    expectTypeOf<DesktopMediaApi>().not.toHaveProperty('getState')
    expectTypeOf<DesktopMediaApi>().not.toHaveProperty('onStats')
  })
})
