import { describe, expect, it, vi } from 'vitest'

vi.mock('#/lib/config', () => ({
  config: { releaseChannel: 'nightly' },
}))

describe('uiFeatureFlags', () => {
  it('enables the achievement debug tools in nightly builds', async () => {
    const { uiFeatureFlags } = await import('./ui-feature-flags')

    expect(uiFeatureFlags.achievementDebug).toBe(true)
  })
})
