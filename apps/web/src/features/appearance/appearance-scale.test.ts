// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'

import { applyAppearanceScale } from '#/features/appearance/appearance-scale'

describe('applyAppearanceScale', () => {
  afterEach(() => {
    document.documentElement.style.fontSize = ''
  })

  it('writes the scale as a root font-size percentage', () => {
    applyAppearanceScale(100)
    expect(document.documentElement.style.fontSize).toBe('100%')

    applyAppearanceScale(125)
    expect(document.documentElement.style.fontSize).toBe('125%')
  })

  it('clamps values outside the supported range', () => {
    applyAppearanceScale(500)
    expect(document.documentElement.style.fontSize).toBe('150%')

    applyAppearanceScale(10)
    expect(document.documentElement.style.fontSize).toBe('80%')
  })

  it('ignores non-finite values', () => {
    applyAppearanceScale(120)
    applyAppearanceScale(Number.NaN)

    expect(document.documentElement.style.fontSize).toBe('120%')
  })
})
