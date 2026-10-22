// @vitest-environment jsdom

import { render } from '@testing-library/react'
import { HolidayProvider } from '@syrnike13/ui/holidays'
import { expect, it } from 'vitest'

import { defineHolidayIcon } from './holiday-icon'
import type { AppIconProps } from './types'

function BaseGlyph(props: AppIconProps) {
  return <svg data-icon="base" {...props} />
}

function VariantGlyph(props: AppIconProps) {
  return <svg data-icon="variant" {...props} />
}

const TestIcon = defineHolidayIcon(
  BaseGlyph,
  { pack: 'custom', name: 'test-glyph' },
  { halloween: VariantGlyph },
)

const HALLOWEEN = () => new Date(2026, 9, 31, 12)
const SUMMER = () => new Date(2026, 5, 15, 12)

it('falls back to the base glyph without a provider', () => {
  const { container } = render(<TestIcon />)

  expect(container.querySelector('[data-icon="base"]')).not.toBeNull()
  expect(container.querySelector('[data-icon="variant"]')).toBeNull()
})

it('renders the holiday glyph on an active holiday', () => {
  const { container } = render(
    <HolidayProvider now={HALLOWEEN}>
      <TestIcon />
    </HolidayProvider>,
  )

  expect(container.querySelector('[data-icon="variant"]')).not.toBeNull()
})

it('renders the base glyph outside the holiday window', () => {
  const { container } = render(
    <HolidayProvider now={SUMMER}>
      <TestIcon />
    </HolidayProvider>,
  )

  expect(container.querySelector('[data-icon="base"]')).not.toBeNull()
})
