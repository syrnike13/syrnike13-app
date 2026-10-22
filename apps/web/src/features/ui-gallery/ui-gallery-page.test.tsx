// @vitest-environment jsdom

import { render, screen } from '@testing-library/react'
import { expect, it } from 'vitest'

import { AppearanceProvider } from '#/features/appearance/appearance-context'
import { UiGalleryPage } from '#/features/ui-gallery/ui-gallery-page'

it('renders the component gallery with every section', () => {
  render(
    <AppearanceProvider>
      <UiGalleryPage />
    </AppearanceProvider>,
  )

  expect(
    screen.getByRole('heading', { name: 'Foundations' }),
  ).toBeInTheDocument()
  expect(screen.getByRole('heading', { name: 'Forms' })).toBeInTheDocument()
  expect(
    screen.getByRole('heading', { name: 'Data display' }),
  ).toBeInTheDocument()
  expect(screen.getByRole('heading', { name: 'Messaging' })).toBeInTheDocument()
  expect(screen.getByRole('heading', { name: 'Overlays' })).toBeInTheDocument()
  expect(screen.getByRole('heading', { name: 'Examples' })).toBeInTheDocument()
  expect(screen.getByText('Palette')).toBeInTheDocument()
})
