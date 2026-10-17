// @vitest-environment jsdom

import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react'
import { afterEach, beforeEach, expect, it } from 'vitest'

import { AppearanceProvider } from '#/features/appearance/appearance-context'
import { PrismTuningOverlay } from '#/features/dev-tools/prism-tuning-overlay'

beforeEach(() => {
  localStorage.clear()
})

afterEach(() => {
  cleanup()
  localStorage.clear()
})

it('opens the Prism tuning panel and exports JSON', () => {
  render(
    <AppearanceProvider>
      <PrismTuningOverlay />
    </AppearanceProvider>,
  )

  fireEvent.click(screen.getByRole('button', { name: 'Prism tuning' }))

  expect(screen.getByText('Prism tuning')).toBeInTheDocument()
  expect(screen.getByLabelText('Card')).toBeInTheDocument()

  fireEvent.click(screen.getByRole('button', { name: 'Export JSON' }))

  const json = screen.getByLabelText('Prism tuning JSON') as HTMLTextAreaElement
  expect(json.value).toContain('"surfaceMix"')
  expect(json.value).toContain('"raisedMix"')
  expect(json.value).toContain('"minInteractionDelta"')
})

it('applies slider changes to the document tokens', async () => {
  render(
    <AppearanceProvider>
      <PrismTuningOverlay />
    </AppearanceProvider>,
  )

  fireEvent.click(screen.getByRole('button', { name: 'Prism tuning' }))

  const before = document.documentElement.style.getPropertyValue('--muted')
  const input = document.querySelectorAll<HTMLInputElement>(
    'input[type="range"]',
  )[3]!
  fireEvent.change(input, { target: { value: '30' } })

  await waitFor(() => {
    expect(screen.getByText('30%')).toBeInTheDocument()
    const after = document.documentElement.style.getPropertyValue('--muted')
    expect(after).not.toBe(before)
  })
})
