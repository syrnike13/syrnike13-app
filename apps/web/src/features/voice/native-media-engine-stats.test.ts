import { describe, expect, it } from 'vitest'

import { nativeMediaEngineStatsStore } from './native-media-engine-stats'

describe('nativeMediaEngineStatsStore', () => {
  it('returns a stable snapshot between store updates', () => {
    nativeMediaEngineStatsStore.reset()

    const first = nativeMediaEngineStatsStore.getState()
    const second = nativeMediaEngineStatsStore.getState()

    expect(second).toBe(first)

    nativeMediaEngineStatsStore.setNative({
      wgc: 1,
      dxgi: 0,
      gdi_blt: 0,
    })

    expect(nativeMediaEngineStatsStore.getState()).not.toBe(first)
  })

  it('does not expose mutable methods internals', () => {
    nativeMediaEngineStatsStore.reset()
    const state = nativeMediaEngineStatsStore.getState()

    expect(() => {
      state.methods.wgc = 10
    }).toThrow(TypeError)
    expect(nativeMediaEngineStatsStore.getState().methods.wgc).toBe(0)
  })

  it('stores native screen capture bottleneck counters', () => {
    nativeMediaEngineStatsStore.reset()

    nativeMediaEngineStatsStore.setNative(
      {
        wgc: 120,
        dxgi: 0,
        gdi_blt: 0,
      },
      'wgc',
      undefined,
      {
        width: 1920,
        height: 1080,
        fps: 60,
        videoFrames: 120,
        videoIntervalFrames: 60,
        videoLateFrames: 1,
        videoNoFrameCount: 2,
        videoRepeatedFrameCount: 3,
        videoRecoverableLostCount: 1,
        videoAvgCaptureUs: 3200,
        videoAvgReadbackUs: 1100,
        videoAvgScaleUs: 900,
        videoAvgPublishUs: 700,
        videoSourceWidth: 2560,
        videoSourceHeight: 1440,
        videoContentWidth: 1920,
        videoContentHeight: 1080,
        captureThreadMmcss: true,
      },
    )

    expect(nativeMediaEngineStatsStore.getState()).toMatchObject({
      backend: 'native',
      activeMethod: 'wgc',
      videoNoFrameCount: 2,
      videoRepeatedFrameCount: 3,
      videoRecoverableLostCount: 1,
      videoAvgCaptureUs: 3200,
      videoAvgReadbackUs: 1100,
      videoAvgScaleUs: 900,
      videoAvgPublishUs: 700,
      videoSourceWidth: 2560,
      videoSourceHeight: 1440,
      videoContentWidth: 1920,
      videoContentHeight: 1080,
      captureThreadMmcss: true,
    })
  })
})
