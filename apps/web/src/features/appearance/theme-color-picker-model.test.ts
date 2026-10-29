import { expect, it } from 'vitest'
import {
  hexToPickerHsv,
  normalizePickerHex,
  pickerHsvToHex,
} from './theme-color-picker-model'

it.each([
  ['#FF0000', 0],
  ['#FFFF00', 60],
  ['#00FF00', 120],
  ['#00FFFF', 180],
  ['#0000FF', 240],
  ['#FF00FF', 300],
])('maps %s to the expected hue and back', (hex, hue) => {
  expect(hexToPickerHsv(hex)).toEqual({ hue, saturation: 1, brightness: 1 })
  expect(pickerHsvToHex({ hue, saturation: 1, brightness: 1 })).toBe(hex)
})

it('round-trips arbitrary colors and preserves hue for achromatic colors', () => {
  for (const hex of ['#5865F2', '#ADADAD', '#000000', '#FFFFFF', '#1A2B3C']) {
    expect(pickerHsvToHex(hexToPickerHsv(hex))).toBe(hex)
  }
  expect(hexToPickerHsv('#000000', 240)).toEqual({
    hue: 240,
    saturation: 0,
    brightness: 0,
  })
  expect(hexToPickerHsv('#FFFFFF', 120).hue).toBe(120)
})

it('normalizes shorthand and rejects invalid or incomplete HEX input', () => {
  expect(normalizePickerHex('abc')).toBe('#AABBCC')
  expect(normalizePickerHex(' #12abCD ')).toBe('#12ABCD')
  for (const value of ['', '#12', '#1234', '#GG0000', '#12345678'])
    expect(normalizePickerHex(value)).toBeNull()
})
