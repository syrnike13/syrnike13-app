import { describe, expect, it } from 'vitest'

import {
  firstEnabledStop,
  getSliderBounds,
  getSliderStep,
  getValueStep,
  lastEnabledStop,
  moveEnabledStop,
  nearestEnabledStop,
  normalizePresetStops,
  sliderLabel,
  sliderPositionToValue,
  sliderValueText,
  stopAtValue,
  valueToSliderPosition,
} from '#/components/ui/preset-slider-logic'

const STOPS = normalizePresetStops([
  { value: 50 },
  { value: 67 },
  { value: 75 },
  { value: 80 },
  { value: 90 },
  { value: 100 },
  { value: 110 },
  { value: 125 },
  { value: 150 },
  { value: 175 },
  { value: 200 },
])

describe('normalizePresetStops', () => {
  it('sorts, deduplicates and numbers stops by value', () => {
    const stops = normalizePresetStops([
      { value: 30 },
      { value: 10 },
      { value: 30, label: 'duplicate' },
      { value: Number.NaN },
    ])

    expect(stops.map((stop) => stop.value)).toEqual([10, 30])
    expect(stops.map((stop) => stop.index)).toEqual([0, 1])
  })
})

describe('slider geometry', () => {
  it('uses real values in value layout and indices in index layout', () => {
    expect(getSliderBounds(STOPS, 'value')).toEqual({ min: 50, max: 200 })
    expect(getSliderBounds(STOPS, 'index')).toEqual({ min: 0, max: 10 })
  })

  it('maps values linearly in value layout', () => {
    expect(valueToSliderPosition(125, STOPS, 'value')).toBe(125)
    expect(sliderPositionToValue(125, STOPS, 'value')).toBe(125)
    expect(valueToSliderPosition(10, STOPS, 'value')).toBe(50)
    expect(sliderPositionToValue(400, STOPS, 'value')).toBe(200)
  })

  it('maps values to evenly spaced indices in index layout', () => {
    expect(valueToSliderPosition(50, STOPS, 'index')).toBe(0)
    expect(valueToSliderPosition(125, STOPS, 'index')).toBe(7)
    expect(valueToSliderPosition(200, STOPS, 'index')).toBe(10)
    expect(valueToSliderPosition(105, STOPS, 'index')).toBeCloseTo(5.5)
    expect(sliderPositionToValue(5.5, STOPS, 'index')).toBe(105)
  })
})

describe('stop selection', () => {
  it('finds the nearest enabled stop and skips disabled ones', () => {
    const stops = normalizePresetStops([
      { value: 100 },
      { value: 110, disabled: true },
      { value: 125 },
    ])

    expect(nearestEnabledStop(stops, 118, 'value')?.value).toBe(125)
    expect(nearestEnabledStop(stops, 104, 'value')?.value).toBe(100)
  })

  it('moves to the next enabled stop and supports larger steps', () => {
    expect(moveEnabledStop(STOPS, 100, 1)?.value).toBe(110)
    expect(moveEnabledStop(STOPS, 100, -1)?.value).toBe(90)
    expect(moveEnabledStop(STOPS, 100, 1, 5)?.value).toBe(200)
    expect(moveEnabledStop(STOPS, 100, -1, 5)?.value).toBe(50)
    expect(moveEnabledStop(STOPS, 200, 1)).toBeNull()
  })

  it('skips disabled stops when moving', () => {
    const stops = normalizePresetStops([
      { value: 100 },
      { value: 110, disabled: true },
      { value: 125 },
    ])

    expect(moveEnabledStop(stops, 100, 1)?.value).toBe(125)
    expect(moveEnabledStop(stops, 125, -1)?.value).toBe(100)
  })

  it('exposes the first and last enabled stops', () => {
    const stops = normalizePresetStops([
      { value: 100, disabled: true },
      { value: 110 },
      { value: 125 },
      { value: 150, disabled: true },
    ])

    expect(firstEnabledStop(stops)?.value).toBe(110)
    expect(lastEnabledStop(stops)?.value).toBe(125)
  })

  it('matches exact values only', () => {
    expect(stopAtValue(STOPS, 125)?.value).toBe(125)
    expect(stopAtValue(STOPS, 126)).toBeNull()
  })
})

describe('steps', () => {
  it('keeps the slider input fine enough to reach every stop', () => {
    expect(getSliderStep(STOPS, 'value', 'stops')).toBe(0.05)
    expect(getSliderStep(STOPS, 'index', 'stops')).toBe(1)
    expect(getSliderStep(STOPS, 'index', 'continuous')).toBe(0.01)
    expect(getSliderStep(STOPS, 'value', 'continuous', 2)).toBe(2)
  })

  it('derives a keyboard step in real value units', () => {
    expect(getValueStep(STOPS, 2)).toBe(2)
    expect(getValueStep(STOPS)).toBe(1.5)
  })
})

describe('sliderLabel', () => {
  it('prefers an explicit label, then the formatter, then the number', () => {
    expect(sliderLabel({ value: 100, label: 'Normal' })).toBe('Normal')
    expect(sliderLabel({ value: 100 }, (value) => `${value}%`)).toBe('100%')
    expect(sliderLabel({ value: 100 })).toBe('100')
  })

  it('treats a null label as a tick-only stop but keeps readable value text', () => {
    expect(sliderLabel({ value: 100, label: null })).toBeNull()
    expect(
      sliderValueText({ value: 100, label: null }, (value) => `${value}%`),
    ).toBe('100%')
    expect(sliderValueText({ value: 100, label: null })).toBe('100')
    expect(sliderValueText({ value: 100 })).toBe('100')
  })
})
