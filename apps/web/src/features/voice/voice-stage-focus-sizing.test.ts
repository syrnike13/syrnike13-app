import { describe, expect, it } from 'vitest'

import {
  computeVoiceStageFocusLayout,
  VOICE_STAGE_FOCUS_MAX_WIDTH_PX,
  VOICE_STAGE_STRIP_TILE_ASPECT,
} from '#/features/voice/voice-stage-focus-sizing'

describe('computeVoiceStageFocusLayout', () => {
  it('caps focus width on ultra-wide screens and keeps strip tiles 16:9', () => {
    const layout = computeVoiceStageFocusLayout(1800, 800, 16 / 9, 2)

    expect(layout.focus.width).toBeLessThanOrEqual(VOICE_STAGE_FOCUS_MAX_WIDTH_PX)
    expect(layout.stripTile.width).toBeGreaterThan(0)
    expect(layout.stripTile.height).toBeCloseTo(
      layout.stripTile.width / VOICE_STAGE_STRIP_TILE_ASPECT,
      0,
    )

    const stackHeight =
      layout.focus.height +
      8 +
      layout.stripTile.height +
      8

    expect(stackHeight).toBeLessThanOrEqual(800)
  })

  it('uses full width on narrow containers', () => {
    const layout = computeVoiceStageFocusLayout(640, 700, 16 / 9, 2)

    expect(layout.focus.width).toBe(640)
    expect(layout.stripTile.height / layout.stripTile.width).toBeCloseTo(
      9 / 16,
      2,
    )
  })
})
