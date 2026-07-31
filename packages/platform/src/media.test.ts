import { describe, expect, expectTypeOf, it } from 'vitest'

import type { SyrnikeDesktopApi } from './api'
import {
  isNativeMediaRuntimeState,
  type NativeMediaStatsEvent,
  type NativeMicrophonePipelineConfig,
} from './media'

describe('native media support contracts', () => {
  it('keeps the microphone pipeline command config for runtime users', () => {
    expectTypeOf<NativeMicrophonePipelineConfig>().toMatchTypeOf<{
      deviceId: string | null
      bypassSystemAudioInputProcessing: boolean
      automaticGainControl: boolean
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
      videoGpuPoolSlotsAvailable?: number
      videoGpuPoolSlotsTotal?: number
      videoDxgiDuplicationHoldUsMax?: number
      videoSourceUpdates?: number
      videoGpuSubmissions?: number
      videoIdleRefreshes?: number
      videoCoalescedSourceUpdates?: number
      videoEncoderBackpressureTicks?: number
      videoSupersededReadyFrames?: number
      videoGpuCompletionP50Us?: number
      videoGpuCompletionP95Us?: number
      videoGpuCompletionMaxUs?: number
    }>()
  })

  it('exposes only renderer-owned media support operations', () => {
    type DesktopMediaApi = SyrnikeDesktopApi['media']
    expectTypeOf<DesktopMediaApi>().toHaveProperty('getRuntimeState')
    expectTypeOf<DesktopMediaApi>().toHaveProperty('retryRuntime')
    expectTypeOf<DesktopMediaApi>().toHaveProperty('onRuntimeState')
    expectTypeOf<DesktopMediaApi>().toHaveProperty('startMicrophonePreview')
    expectTypeOf<DesktopMediaApi>().toHaveProperty('setRemoteVideoDemand')
    expectTypeOf<DesktopMediaApi>().toHaveProperty('setLocalScreenPreviewDemand')
    expectTypeOf<DesktopMediaApi>().not.toHaveProperty('applyLocalMediaIntent')
    expectTypeOf<DesktopMediaApi>().not.toHaveProperty('configureMicrophonePipeline')
    expectTypeOf<DesktopMediaApi>().not.toHaveProperty('getState')
    expectTypeOf<DesktopMediaApi>().not.toHaveProperty('onStats')
  })

  it('validates the runtime state crossing the preload boundary', () => {
    expect(isNativeMediaRuntimeState({
      available: true,
      status: 'degraded',
      restartCount: 3,
      degradedReason: 'circuit open',
      degradedRetryAttempt: 1,
      nextRetryAt: 30_000,
    })).toBe(true)
    expect(isNativeMediaRuntimeState({
      available: true,
      status: 'degraded',
      restartCount: -1,
    })).toBe(false)
  })
})
