import { describe, expect, it } from 'vitest'

import {
  computeVoiceStageFocusLayout,
  VOICE_STAGE_STRIP_TILE_ASPECT,
} from '#/features/voice/voice-stage-focus-sizing'

describe('computeVoiceStageFocusLayout', () => {
  it('fills available width on wide screens and keeps strip tiles 16:9', () => {
    const layout = computeVoiceStageFocusLayout(1733, 1155, 16 / 9, 3)

    // Высоты с запасом → стрим упирается в полную ширину контейнера.
    expect(layout.focus.width).toBe(1733)
    expect(layout.focus.height / layout.focus.width).toBeCloseTo(9 / 16, 2)
    expect(layout.stripTile.width).toBeGreaterThan(0)
    expect(layout.stripTile.height).toBeCloseTo(
      layout.stripTile.width / VOICE_STAGE_STRIP_TILE_ASPECT,
      0,
    )

    const stackHeight =
      layout.focus.height + 8 + layout.stripTile.height + 8

    expect(stackHeight).toBeLessThanOrEqual(1155)
  })

  it('is height-bound on short ultra-wide stages without overflowing', () => {
    const layout = computeVoiceStageFocusLayout(1800, 800, 16 / 9, 2)

    // Высота не позволяет занять всю ширину → фокус ограничен по высоте.
    expect(layout.focus.width).toBeLessThan(1800)
    expect(layout.focus.height / layout.focus.width).toBeCloseTo(9 / 16, 2)

    const stackHeight =
      layout.focus.height + 8 + layout.stripTile.height + 8

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

  it('grows focus to fill height when the strip is collapsed', () => {
    const withStrip = computeVoiceStageFocusLayout(1200, 500, 16 / 9, 2)
    const collapsed = computeVoiceStageFocusLayout(1200, 500, 16 / 9, 0, true)

    expect(collapsed.focus.height).toBeGreaterThan(withStrip.focus.height)
    expect(collapsed.focus.width).toBeGreaterThanOrEqual(withStrip.focus.width)
    expect(collapsed.focus.height / collapsed.focus.width).toBeCloseTo(9 / 16, 2)
  })

  it('does not reserve strip tiles when there is no strip', () => {
    const layout = computeVoiceStageFocusLayout(800, 600, 16 / 9, 0)

    expect(layout.stripTile.width).toBe(0)
    expect(layout.stripTile.height).toBe(0)
    expect(layout.focus.height / layout.focus.width).toBeCloseTo(9 / 16, 2)
  })
})
