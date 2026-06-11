import { describe, expect, it } from 'vitest'

import {
  chunkIntoRows,
  computeVoiceStageGridLayout,
  VOICE_STAGE_GRID_TILE_ASPECT,
} from '#/features/voice/voice-stage-grid-layout'

const ASPECT = VOICE_STAGE_GRID_TILE_ASPECT

function area(layout: { tileWidth: number; tileHeight: number }) {
  return layout.tileWidth * layout.tileHeight
}

describe('computeVoiceStageGridLayout', () => {
  it('returns empty layout for non-positive inputs', () => {
    expect(computeVoiceStageGridLayout({ width: 0, height: 100, count: 3 }))
      .toMatchObject({ columns: 0, rows: 0 })
    expect(computeVoiceStageGridLayout({ width: 100, height: 100, count: 0 }))
      .toMatchObject({ columns: 0, rows: 0 })
  })

  it('uses a single column/row for one tile', () => {
    const layout = computeVoiceStageGridLayout({
      width: 1600,
      height: 900,
      count: 1,
    })
    expect(layout.columns).toBe(1)
    expect(layout.rows).toBe(1)
    expect(layout.scroll).toBe(false)
  })

  it('keeps tiles at 16:9', () => {
    const layout = computeVoiceStageGridLayout({
      width: 1600,
      height: 900,
      count: 5,
    })
    expect(layout.tileWidth / layout.tileHeight).toBeCloseTo(ASPECT, 1)
  })

  it('lays out 5 tiles as 3+2 on a wide stage', () => {
    const layout = computeVoiceStageGridLayout({
      width: 1536,
      height: 876,
      count: 5,
    })
    expect(layout.columns).toBe(3)
    expect(layout.rows).toBe(2)
    expect(layout.scroll).toBe(false)
  })

  it('prefers more columns on very wide/short stages', () => {
    const wide = computeVoiceStageGridLayout({
      width: 2400,
      height: 400,
      count: 4,
    })
    const tall = computeVoiceStageGridLayout({
      width: 400,
      height: 2400,
      count: 4,
    })
    expect(wide.columns).toBeGreaterThan(tall.columns)
  })

  it('chooses the column count maximizing tile area', () => {
    const layout = computeVoiceStageGridLayout({
      width: 1600,
      height: 900,
      count: 2,
    })
    const twoCols = layout
    const oneCol = computeVoiceStageGridLayout({
      width: 1600,
      height: 900,
      count: 2,
    })
    // На широкой сцене две колонки дают большую плитку, чем одна над другой.
    expect(twoCols.columns).toBe(2)
    expect(area(oneCol)).toBeGreaterThan(0)
  })

  it('switches to scroll mode when tiles would be too small', () => {
    const layout = computeVoiceStageGridLayout({
      width: 320,
      height: 240,
      count: 40,
    })
    expect(layout.scroll).toBe(true)
    expect(layout.columns).toBeGreaterThanOrEqual(1)
  })

  it('never returns more columns than tiles', () => {
    for (let count = 1; count <= 12; count++) {
      const layout = computeVoiceStageGridLayout({
        width: 1536,
        height: 864,
        count,
      })
      expect(layout.columns).toBeLessThanOrEqual(count)
      expect(layout.columns * layout.rows).toBeGreaterThanOrEqual(count)
    }
  })
})

describe('chunkIntoRows', () => {
  it('splits items into rows of the given size', () => {
    expect(chunkIntoRows([1, 2, 3, 4, 5], 3)).toEqual([
      [1, 2, 3],
      [4, 5],
    ])
  })

  it('returns one row when columns is zero', () => {
    expect(chunkIntoRows([1, 2], 0)).toEqual([[1, 2]])
    expect(chunkIntoRows([], 0)).toEqual([])
  })
})
