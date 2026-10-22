// @vitest-environment jsdom

import { act, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'

import { HolidayProvider, useActiveHoliday } from './provider'

const HALLOWEEN = () => new Date(2026, 9, 31, 12)
const SUMMER = () => new Date(2026, 5, 15, 12)

function ActiveHoliday() {
  const holiday = useActiveHoliday()
  return <span>{holiday ? holiday.id : 'none'}</span>
}

afterEach(() => {
  vi.useRealTimers()
  localStorage.clear()
})

it('publishes the holiday of the current day', () => {
  render(
    <HolidayProvider now={HALLOWEEN}>
      <ActiveHoliday />
    </HolidayProvider>,
  )

  expect(screen.getByText('halloween')).not.toBeNull()
})

it('publishes nothing outside the holiday window', () => {
  render(
    <HolidayProvider now={SUMMER}>
      <ActiveHoliday />
    </HolidayProvider>,
  )

  expect(screen.getByText('none')).not.toBeNull()
})

it('returns null without a provider', () => {
  render(<ActiveHoliday />)

  expect(screen.getByText('none')).not.toBeNull()
})

it('ignores a stored dev preview when production does not provide a storage key', () => {
  localStorage.setItem('syrnike13-holiday-override:v1', 'halloween')

  render(
    <HolidayProvider now={SUMMER}>
      <ActiveHoliday />
    </HolidayProvider>,
  )

  expect(screen.getByText('none')).not.toBeNull()
})

it('re-checks the date on the refresh interval', () => {
  vi.useFakeTimers()

  let now = new Date(2026, 10, 1, 23, 59)
  render(
    <HolidayProvider now={() => now} refreshIntervalMs={1000}>
      <ActiveHoliday />
    </HolidayProvider>,
  )

  expect(screen.getByText('halloween')).not.toBeNull()

  now = new Date(2026, 10, 2, 0, 1)
  act(() => {
    vi.advanceTimersByTime(1000)
  })

  expect(screen.getByText('none')).not.toBeNull()
})
