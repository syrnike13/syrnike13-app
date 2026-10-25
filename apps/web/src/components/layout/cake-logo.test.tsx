// @vitest-environment jsdom

import { act, render } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'

import { resolveActiveHoliday, toMonthDay } from '@syrnike13/ui/holidays'

import { CakeLogo, cakeLogoVariantForHoliday } from './cake-logo'
import { CAKE_PIXELS, CAKE_TETROMINOES } from './cake-logo-data'

afterEach(() => {
  vi.restoreAllMocks()
  vi.useRealTimers()
})

it('holds the full logo for 1.5 seconds, assembles it for one second, and returns to still', () => {
  vi.useFakeTimers()
  const { container } = render(<CakeLogo />)

  expect(container.querySelector('.cake-logo')?.getAttribute('data-phase')).toBe('still')
  expect(container.querySelector('image')?.getAttribute('mask')).toBeNull()
  expect(container.querySelectorAll('.cake-logo-piece')).toHaveLength(0)

  act(() => vi.advanceTimersByTime(1480))
  expect(container.querySelector('.cake-logo')?.getAttribute('data-phase')).toBe('still')
  act(() => vi.advanceTimersByTime(20))
  expect(container.querySelector('.cake-logo')?.getAttribute('data-phase')).toBe('assembly')

  const pieces = container.querySelectorAll('.cake-logo-piece')
  expect(pieces.length).toBeGreaterThan(0)
  expect(new Set(CAKE_TETROMINOES.map((piece) => piece.kind)).size).toBe(7)

  for (const piece of pieces) {
    const cells = Array.from(piece.querySelectorAll('.cake-tetromino-blocks rect'), (cell) => ({
      x: Number(cell.getAttribute('x')),
      y: Number(cell.getAttribute('y')),
    }))
    expect(cells).toHaveLength(4)

    // Four edge-connected grid cells are one of the seven tetrominoes, not
    // four unrelated pixels moving at the same time.
    const connected = new Set([cells[0]])
    for (let pass = 0; pass < 3; pass += 1) {
      for (const cell of cells) {
        if (Array.from(connected).some((other) =>
          Math.abs(cell.x - other.x) + Math.abs(cell.y - other.y) === 2,
        )) connected.add(cell)
      }
    }
    expect(connected.size).toBe(4)
  }

  // The artwork is painted once, while the reveal mask covers every source
  // pixel exactly once. Adjacent pieces must not leave gaps or overlap.
  expect(container.querySelectorAll('image.cake-logo-artwork')).toHaveLength(1)
  expect(container.querySelectorAll('[data-landed-piece]')).toHaveLength(0)

  act(() => vi.advanceTimersByTime(260))
  expect(container.querySelectorAll('[data-landed-piece]')).toHaveLength(0)

  act(() => vi.advanceTimersByTime(20))
  expect(container.querySelectorAll('[data-landed-piece]')).toHaveLength(1)
  expect(container.querySelectorAll('.cake-tetromino-blocks')).toHaveLength(pieces.length - 1)

  act(() => vi.advanceTimersByTime(700))
  expect(container.querySelectorAll('.cake-tetromino-blocks')).toHaveLength(1)
  expect(container.querySelectorAll('[data-landed-piece]')).toHaveLength(pieces.length - 1)

  const revealCells = Array.from(container.querySelectorAll('[data-landed-piece] rect, .cake-tetromino-blocks rect'),
    (cell) => ({
      x: Number(cell.getAttribute('x')),
      y: Number(cell.getAttribute('y')),
      size: Number(cell.getAttribute('width')),
    }),
  )
  for (const pixel of CAKE_PIXELS) {
    expect(revealCells.filter((cell) =>
      pixel.x >= cell.x && pixel.x < cell.x + cell.size &&
      pixel.y >= cell.y && pixel.y < cell.y + cell.size,
    )).toHaveLength(1)
  }

  act(() => vi.advanceTimersByTime(20))
  expect(container.querySelector('.cake-logo')?.getAttribute('data-phase')).toBe('still')
  expect(container.querySelector('image')?.getAttribute('mask')).toBeNull()
  expect(container.querySelectorAll('.cake-logo-piece')).toHaveLength(0)
})

it('replays only Tetris and cleans up the timeline on unmount', () => {
  vi.useFakeTimers()
  const { container, unmount } = render(<CakeLogo />)
  const initial = container.querySelector<SVGElement>('.cake-logo')
  const duration = parseFloat(initial?.style.getPropertyValue('--cake-cycle-duration') ?? '0')
  expect(duration).toBeGreaterThan(0)
  expect(duration).toBe(2500)

  act(() => vi.advanceTimersByTime(duration * 2))

  expect(container.querySelector('.cake-logo')).not.toBe(initial)
  expect(container.querySelector('.cake-logo')?.getAttribute('data-phase')).toBe('still')
  act(() => vi.advanceTimersByTime(1500))
  expect(container.querySelectorAll('.cake-logo-piece')).toHaveLength(CAKE_TETROMINOES.length)
  expect(container.querySelectorAll('[data-landed-piece]')).toHaveLength(0)
  unmount()
  expect(vi.getTimerCount()).toBe(0)
})

it('keeps the whole logo on Halloween with pumpkins and bats', () => {
  vi.useFakeTimers()
  const { container } = render(<CakeLogo previewMotion variant="halloween" />)

  expect(container.querySelector('image')?.getAttribute('mask')).toBeNull()
  expect(container.querySelector('.cake-lantern')).not.toBeNull()
  expect(container.querySelectorAll('.cake-bat')).toHaveLength(2)
  expect(container.querySelectorAll('.cake-logo-piece')).toHaveLength(0)
  expect(vi.getTimerCount()).toBe(0)
})

it('keeps the logo whole for New Year under snow with a fir tree', () => {
  vi.useFakeTimers()
  const { container } = render(<CakeLogo previewMotion variant="new-year" />)

  expect(container.querySelector('image')?.getAttribute('mask')).toBeNull()
  expect(container.querySelector('.cake-star')).not.toBeNull()
  expect(container.querySelectorAll('.cake-snowflake').length).toBeGreaterThan(0)
  expect(container.querySelectorAll('.cake-logo-piece')).toHaveLength(0)
  expect(vi.getTimerCount()).toBe(0)
})

it('keeps a complete static logo for reduced motion until preview playback is requested', () => {
  vi.useFakeTimers()
  vi.spyOn(window, 'matchMedia').mockReturnValue({
    matches: true,
    media: '(prefers-reduced-motion: reduce)',
    onchange: null,
    addListener: vi.fn(),
    removeListener: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: () => true,
  })
  const { container, rerender } = render(<CakeLogo />)

  expect(container.querySelector('image')?.getAttribute('mask')).toBeNull()
  expect(container.querySelectorAll('.cake-tetromino-blocks')).toHaveLength(0)
  expect(vi.getTimerCount()).toBe(0)

  rerender(<CakeLogo previewMotion />)
  expect(container.querySelector('image')?.getAttribute('mask')).toBeNull()
  act(() => vi.advanceTimersByTime(1500))
  expect(container.querySelector('image')?.getAttribute('mask')).toContain('url(')
  act(() => vi.advanceTimersByTime(1000))
  expect(container.querySelectorAll('.cake-tetromino-blocks')).toHaveLength(0)
  expect(container.querySelector('image')?.getAttribute('mask')).toBeNull()
  expect(container.querySelector('.cake-logo')?.getAttribute('data-phase')).toBe('still')
})

it('picks the holiday scene from the real local date', () => {
  const sceneOn = (year: number, month: number, day: number) =>
    cakeLogoVariantForHoliday(
      resolveActiveHoliday(toMonthDay(new Date(year, month - 1, day)))?.id,
    )

  expect(sceneOn(2026, 10, 16)).toBe('classic')
  expect(sceneOn(2026, 10, 17)).toBe('halloween')
  expect(sceneOn(2026, 10, 31)).toBe('halloween')
  expect(sceneOn(2026, 11, 3)).toBe('halloween')
  expect(sceneOn(2026, 11, 4)).toBe('classic')
  expect(sceneOn(2026, 11, 30)).toBe('classic')
  expect(sceneOn(2026, 12, 1)).toBe('new-year')
  expect(sceneOn(2027, 1, 7)).toBe('new-year')
  expect(sceneOn(2027, 1, 14)).toBe('new-year')
  expect(sceneOn(2027, 1, 15)).toBe('classic')
})
