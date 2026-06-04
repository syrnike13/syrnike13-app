import { describe, expect, it } from 'vitest'

import {
  fallbackTilePalette,
  paletteFromRgb,
} from '#/lib/avatar-tile-palette'

describe('fallbackTilePalette', () => {
  it('is stable for the same user id', () => {
    const first = fallbackTilePalette('user-abc')
    const second = fallbackTilePalette('user-abc')
    expect(first).toEqual(second)
  })

  it('can differ for different user ids', () => {
    const palettes = new Set(
      ['a', 'b', 'c', 'd', 'e', 'f'].map((id) =>
        JSON.stringify(fallbackTilePalette(id)),
      ),
    )
    expect(palettes.size).toBeGreaterThan(1)
  })
})

describe('paletteFromRgb', () => {
  it('returns a darker gradient endpoint', () => {
    const palette = paletteFromRgb(120, 180, 220)
    expect(palette.from).toMatch(/^#[0-9a-f]{6}$/i)
    expect(palette.to).toMatch(/^#[0-9a-f]{6}$/i)
    expect(palette.from).not.toEqual(palette.to)
  })
})
