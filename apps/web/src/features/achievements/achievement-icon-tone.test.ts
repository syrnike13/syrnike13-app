import { describe, expect, it } from 'vitest'

import { buildToneRamp, toneMapPixels } from './achievement-icon-tone'

const BASE = [228, 188, 96] as const

function pixels(...colors: Array<[number, number, number, number]>) {
  return new Uint8ClampedArray(colors.flat())
}

describe('toneMapPixels', () => {
  it('maps the darkest and brightest pixels to the ends of the bronze ramp', () => {
    const ramp = buildToneRamp(BASE)
    const data = pixels([0, 0, 0, 255], [128, 128, 128, 255], [255, 255, 255, 255])

    toneMapPixels(data, ramp)

    expect([...data.slice(0, 3)]).toEqual([...ramp[0]![1]])
    expect([...data.slice(8, 11)]).toEqual([...ramp[ramp.length - 1]![1]])
  })

  it('never turns highlights white', () => {
    const data = pixels([30, 30, 30, 255], [250, 250, 240, 255])

    toneMapPixels(data, buildToneRamp(BASE))

    expect(data[6]).toBeLessThan(200)
  })

  it('stretches a dark icon to the full ramp', () => {
    const ramp = buildToneRamp(BASE)
    const data = pixels([0, 0, 0, 255], [0, 90, 140, 255])

    toneMapPixels(data, ramp)

    expect([...data.slice(4, 7)]).toEqual([...ramp[ramp.length - 1]![1]])
  })

  it('keeps transparent pixels untouched', () => {
    const data = pixels([10, 20, 30, 0], [200, 200, 200, 255])

    toneMapPixels(data, buildToneRamp(BASE))

    expect([...data.slice(0, 4)]).toEqual([10, 20, 30, 0])
  })
})
