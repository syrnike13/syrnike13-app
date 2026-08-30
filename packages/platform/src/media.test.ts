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
      videoGpuSlotTimeouts?: number
      videoGpuSlotsRecovered?: number
      videoGpuFramesDroppedStale?: number
      videoGpuPoolRollovers?: number
      videoGpuRolloversBlocked?: number
      videoGpuRetiredGenerations?: number
      videoGpuSlotsQuarantined?: number
      videoPreviewBridgeSubmissions?: number
      videoPreviewBridgeAcquires?: number
      videoPreviewBridgeTimeouts?: number
      videoPreviewBridgeSlotsRecovered?: number
      videoPreviewGpuSubmissions?: number
      videoPreviewFramesCompleted?: number
      videoPreviewSlotTimeouts?: number
      videoPreviewFramesDroppedStale?: number
      videoPreviewDeviceResets?: number
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
      available: false,
      status: 'unavailable',
      restartCount: 0,
      failure: {
        code: 'native_media_unavailable',
        message: 'Native media is unavailable while the v2 engine is rebuilt.',
        retryable: false,
        stage: 'native_runtime',
      },
    })).toBe(true)
    expect(isNativeMediaRuntimeState({
      available: false,
      status: 'stopped',
      restartCount: 0,
    })).toBe(false)
  })
})
