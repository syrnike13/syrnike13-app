import { afterEach, describe, expect, it, vi } from 'vitest'

const testState = vi.hoisted(() => ({
  releaseChannel: 'stable' as 'stable' | 'nightly',
}))

vi.mock('#/lib/config', () => ({
  config: {
    get releaseChannel() {
      return testState.releaseChannel
    },
  },
}))

describe('uiFeatureFlags', () => {
  afterEach(() => {
    vi.resetModules()
  })

  it('hides experimental UI in stable builds', async () => {
    testState.releaseChannel = 'stable'

    const { uiFeatureFlags } = await import('./ui-feature-flags')

    expect(uiFeatureFlags.channelActivities).toBe(false)
  })

  it('enables experimental UI in nightly builds', async () => {
    testState.releaseChannel = 'nightly'

    const { uiFeatureFlags } = await import('./ui-feature-flags')

    expect(uiFeatureFlags.channelActivities).toBe(true)
  })
})
