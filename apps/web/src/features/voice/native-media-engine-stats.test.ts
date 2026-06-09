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
      gdi_print: 0,
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
})
