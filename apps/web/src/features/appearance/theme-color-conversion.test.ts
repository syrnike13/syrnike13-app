import { describe, expect, it } from 'vitest'

import { cssColorToHex } from '#/features/appearance/theme-color-conversion'

describe('cssColorToHex', () => {
  it('normalizes hex and rgb colors', () => {
    expect(cssColorToHex('#aabbcc')).toBe('#AABBCC')
    expect(cssColorToHex('rgb(17 34 51 / 0.5)')).toBe('#112233')
  })

  it('converts neutral oklch colors to sRGB hex', () => {
    expect(cssColorToHex('oklch(1 0 0)')).toBe('#FFFFFF')
    expect(cssColorToHex('oklch(0 0 0)')).toBe('#000000')
    expect(cssColorToHex('oklch(50% 0 0)')).toMatch(/^#[0-9A-F]{6}$/)
  })

  it('rejects unsupported values', () => {
    expect(cssColorToHex('linear-gradient(red, blue)')).toBeNull()
  })
})
