// @vitest-environment jsdom

import { describe, expect, it } from 'vitest'

import {
  floatingCornerFromStorage,
  isFloatingCorner,
  nearestFloatingCorner,
} from '#/lib/floating-corner'

describe('floating-corner', () => {
  it('detects valid corners', () => {
    expect(isFloatingCorner('top-left')).toBe(true)
    expect(isFloatingCorner('bottom-right')).toBe(true)
    expect(isFloatingCorner('center')).toBe(false)
  })

  it('picks the nearest viewport corner', () => {
    expect(nearestFloatingCorner(10, 10, 400, 800)).toBe('top-left')
    expect(nearestFloatingCorner(390, 10, 400, 800)).toBe('top-right')
    expect(nearestFloatingCorner(10, 790, 400, 800)).toBe('bottom-left')
    expect(nearestFloatingCorner(390, 790, 400, 800)).toBe('bottom-right')
  })

  it('falls back when storage is missing or invalid', () => {
    const key = 'syrnike13.test.floatingCorner'
    window.localStorage.removeItem(key)
    expect(floatingCornerFromStorage(key, 'bottom-left')).toBe('bottom-left')
    window.localStorage.setItem(key, 'nope')
    expect(floatingCornerFromStorage(key, 'top-right')).toBe('top-right')
    window.localStorage.setItem(key, 'bottom-right')
    expect(floatingCornerFromStorage(key, 'top-left')).toBe('bottom-right')
    window.localStorage.removeItem(key)
  })
})
