import { describe, expect, it } from 'vitest'

import {
  clampMosaicRatio,
  layoutAttachmentMosaic,
} from '#/features/chat/attachment-mosaic-layout'

describe('layoutAttachmentMosaic', () => {
  it('keeps a single image at its own aspect ratio', () => {
    const layout = layoutAttachmentMosaic([16 / 9])
    expect(layout.tiles).toHaveLength(1)
    expect(layout.aspectRatio).toBeCloseTo(16 / 9, 5)
    expect(layout.tiles[0]).toMatchObject({
      index: 0,
      left: 0,
      top: 0,
      width: 100,
      height: 100,
    })
  })

  it('places two landscape images in a vertical stack', () => {
    const layout = layoutAttachmentMosaic([1.8, 1.6])
    expect(layout.tiles).toHaveLength(2)
    // обе на всю ширину, друг под другом
    expect(layout.tiles[0]?.width).toBeCloseTo(100, 0)
    expect(layout.tiles[1]?.width).toBeCloseTo(100, 0)
    expect(layout.tiles[1]!.top).toBeGreaterThan(40)
  })

  it('places two mixed images side by side with different widths', () => {
    const layout = layoutAttachmentMosaic([1.8, 0.6])
    expect(layout.tiles).toHaveLength(2)
    expect(layout.tiles[0]!.top).toBeCloseTo(0, 0)
    expect(layout.tiles[1]!.top).toBeCloseTo(0, 0)
    expect(layout.tiles[0]!.width).toBeGreaterThan(layout.tiles[1]!.width)
  })

  it('uses a left sidebar layout for three portraits', () => {
    const layout = layoutAttachmentMosaic([0.7, 0.8, 0.75])
    expect(layout.tiles).toHaveLength(3)
    const primary = layout.tiles.find((tile) => tile.index === 0)!
    const secondary = layout.tiles.filter((tile) => tile.index !== 0)
    expect(primary.left).toBe(0)
    expect(primary.height).toBeCloseTo(100, 0)
    expect(secondary.every((tile) => tile.left > primary.width)).toBe(true)
  })

  it('lays out five images without cropping count', () => {
    const layout = layoutAttachmentMosaic([1.2, 1.1, 0.9, 1.4, 0.8])
    expect(layout.tiles).toHaveLength(5)
    expect(new Set(layout.tiles.map((tile) => tile.index)).size).toBe(5)
    for (const tile of layout.tiles) {
      expect(tile.width).toBeGreaterThan(5)
      expect(tile.height).toBeGreaterThan(5)
    }
  })

  it('clamps absurd ratios', () => {
    expect(clampMosaicRatio(0.01)).toBeGreaterThan(0.4)
    expect(clampMosaicRatio(20)).toBeLessThan(2.5)
  })
})
