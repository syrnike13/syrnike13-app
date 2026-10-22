// @vitest-environment jsdom

import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react'
import { afterEach, beforeEach, expect, it } from 'vitest'

import { HolidayProvider } from '@syrnike13/ui/holidays'
import { HomeIcon, BellIcon, SearchIcon, SmileIcon } from '#/components/icons'

import { AppearanceProvider } from '#/features/appearance/appearance-context'
import { resetDevVoiceGhosts } from '#/features/voice/dev-voice-stage-ghosts'
import { DevToolsOverlay } from './dev-tools-overlay'

const HALLOWEEN = () => new Date(2026, 9, 31, 12)

function renderDevTools(overrideStorageKey?: string) {
  return render(
    <AppearanceProvider>
      <HolidayProvider
        now={HALLOWEEN}
        overrideStorageKey={overrideStorageKey}
      >
        <DevToolsOverlay />
        <div data-testid="product-icons">
          <HomeIcon />
          <BellIcon />
          <SearchIcon />
          <SmileIcon />
        </div>
      </HolidayProvider>
    </AppearanceProvider>,
  )
}

/** Base UI exposes the thumb by label and keeps the range input inside the root. */
function sliderInput(name: string) {
  const root = screen.getByLabelText(name).closest('[data-slot="slider"]')
  const input = root?.querySelector<HTMLInputElement>('input[type="range"]')
  if (!input) throw new Error(`Slider input not found: ${name}`)
  return input
}

beforeEach(() => {
  localStorage.clear()
  resetDevVoiceGhosts()
})

afterEach(() => {
  cleanup()
  localStorage.clear()
  resetDevVoiceGhosts()
})

it('switches holidays from the shared DEV panel', () => {
  renderDevTools()

  expect(screen.getByRole('button', { name: 'DEV' })).toBeInTheDocument()

  fireEvent.click(screen.getByRole('button', { name: 'DEV' }))

  expect(screen.getByRole('dialog', { name: 'Dev tools' })).toBeInTheDocument()
  expect(screen.getByText('10-31')).toBeInTheDocument()
  expect(screen.getByText('Хэллоуин · calendar')).toBeInTheDocument()

  fireEvent.click(
    screen.getByRole('button', { name: 'День святого Валентина' }),
  )

  expect(
    screen.getByText('День святого Валентина · dev override'),
  ).toBeInTheDocument()
  expect(document.documentElement.dataset.holiday).toBeUndefined()

  fireEvent.click(screen.getByRole('button', { name: 'Off' }))

  expect(screen.getByText('None')).toBeInTheDocument()
  expect(document.documentElement.dataset.holiday).toBeUndefined()

  fireEvent.click(screen.getByRole('button', { name: 'Reset to calendar' }))

  expect(screen.getByText('Хэллоуин · calendar')).toBeInTheDocument()
  expect(document.documentElement.dataset.holiday).toBeUndefined()
})

it('controls the visual voice stage ghosts', () => {
  renderDevTools()

  fireEvent.click(screen.getByRole('button', { name: 'DEV' }))
  fireEvent.click(screen.getByRole('tab', { name: 'Voice' }))

  expect(screen.getByText('Voice stage ghosts')).toBeInTheDocument()

  fireEvent.click(screen.getByRole('switch', { name: 'Hide Nova' }))
  expect(
    screen.getByRole('switch', { name: 'Show Nova' }),
  ).toBeInTheDocument()

  fireEvent.click(screen.getByRole('switch', { name: 'Show Nova' }))
  expect(
    screen.getByRole('switch', { name: 'Hide Nova' }),
  ).toBeInTheDocument()

  fireEvent.click(screen.getByRole('button', { name: 'Mute Nova' }))
  expect(
    screen.getByRole('button', { name: 'Unmute Nova' }),
  ).toBeInTheDocument()

  fireEvent.click(screen.getByRole('button', { name: /Stop Nova.s demo/ }))
  expect(
    screen.getByRole('button', { name: /Start Nova.s demo/ }),
  ).toBeInTheDocument()
})

it('opens the theme workbench and exports one JSON for every theme', () => {  renderDevTools()

  fireEvent.click(screen.getByRole('button', { name: 'DEV' }))
  fireEvent.click(screen.getByRole('tab', { name: 'Themes' }))

  expect(screen.getByRole('button', { name: 'monolit' })).toHaveAttribute(
    'aria-pressed',
    'true',
  )

  fireEvent.click(screen.getByRole('button', { name: 'Surfaces' }))
  expect(screen.getByLabelText('Card')).toBeInTheDocument()

  fireEvent.click(screen.getByRole('button', { name: 'Export JSON' }))

  const json = JSON.parse(
    screen.getByRole<HTMLTextAreaElement>('textbox', {
      name: 'Prism themes JSON',
    }).value,
  )
  expect(json.themes.map((theme: { id: string }) => theme.id)).toEqual([
    'monolit',
    'glina',
    'matrix',
    'amber',
    'synthwave',
    'ocean',
    'sakura',
  ])
  expect(json.tuning.surfaceMix).toBeDefined()
  expect(json.tuning.minInteractionDelta).toBeDefined()
})

it('edits anchor colors live and exports them in the JSON', async () => {
  renderDevTools()

  fireEvent.click(screen.getByRole('button', { name: 'DEV' }))
  fireEvent.click(screen.getByRole('tab', { name: 'Themes' }))

  fireEvent.change(screen.getByLabelText('Dark background picker'), {
    target: { value: '#112233' },
  })

  await waitFor(() => {
    expect(
      document.documentElement.style.getPropertyValue('--background'),
    ).toBe('#112233')
  })

  fireEvent.click(screen.getByRole('button', { name: 'Export JSON' }))

  const json = JSON.parse(
    screen.getByRole<HTMLTextAreaElement>('textbox', {
      name: 'Prism themes JSON',
    }).value,
  )
  const monolit = json.themes.find(
    (theme: { id: string }) => theme.id === 'monolit',
  )
  expect(monolit.anchors.dark.background).toBe('#112233')
  expect(monolit.anchors.light.accent).toBeTruthy()
})

it('adds a theme and exports it next to the catalog themes', async () => {
  renderDevTools()

  fireEvent.click(screen.getByRole('button', { name: 'DEV' }))
  fireEvent.click(screen.getByRole('tab', { name: 'Themes' }))

  fireEvent.click(screen.getByRole('button', { name: 'New theme' }))
  fireEvent.change(screen.getByLabelText('New theme id'), {
    target: { value: 'ocean-draft' },
  })
  fireEvent.click(screen.getByRole('button', { name: 'Create' }))

  await waitFor(() => {
    expect(screen.getByRole('button', { name: 'ocean-draft' })).toHaveAttribute(
      'aria-pressed',
      'true',
    )
  })

  fireEvent.click(screen.getByRole('button', { name: 'Export JSON' }))

  const json = JSON.parse(
    screen.getByRole<HTMLTextAreaElement>('textbox', {
      name: 'Prism themes JSON',
    }).value,
  )
  const ocean = json.themes.find(
    (theme: { id: string }) => theme.id === 'ocean-draft',
  )
  expect(ocean.origin).toBe('added')
  expect(json.themes).toHaveLength(8)
})

it('previews every catalog theme and restores the saved theme on close', async () => {
  renderDevTools()

  fireEvent.click(screen.getByRole('button', { name: 'DEV' }))
  fireEvent.click(screen.getByRole('tab', { name: 'Themes' }))

  fireEvent.click(screen.getByRole('button', { name: 'glina' }))

  await waitFor(() => {
    expect(document.documentElement.dataset.theme).toBe('glina')
    expect(
      document.documentElement.style.getPropertyValue('--background'),
    ).toBe('#1a1512')
  })

  fireEvent.click(screen.getByRole('button', { name: 'Close dev tools' }))

  await waitFor(() => {
    expect(document.documentElement.dataset.theme).toBe('monolit')
  })
})

it('restores saved workbench edits after a reload', async () => {
  const { unmount } = renderDevTools()

  fireEvent.click(screen.getByRole('button', { name: 'DEV' }))
  fireEvent.click(screen.getByRole('tab', { name: 'Themes' }))
  fireEvent.change(screen.getByLabelText('Dark accent picker'), {
    target: { value: '#ff8800' },
  })

  await waitFor(() => {
    expect(
      localStorage.getItem('syrnike13-prism-workbench:v1'),
    ).toContain('#ff8800')
  })

  unmount()
  renderDevTools()

  fireEvent.click(screen.getByRole('button', { name: 'DEV' }))
  fireEvent.click(screen.getByRole('tab', { name: 'Themes' }))

  expect(screen.getByLabelText('Dark accent')).toHaveValue('#ff8800')
})

it('applies Prism slider changes to the document tokens', async () => {
  renderDevTools()

  fireEvent.click(screen.getByRole('button', { name: 'DEV' }))
  fireEvent.click(screen.getByRole('tab', { name: 'Themes' }))
  fireEvent.click(screen.getByRole('button', { name: 'Surfaces' }))

  const before = document.documentElement.style.getPropertyValue('--muted')
  fireEvent.change(sliderInput('Muted'), {
    target: { value: '30' },
  })

  await waitFor(() => {
    expect(screen.getByText('30%')).toBeInTheDocument()
    const after = document.documentElement.style.getPropertyValue('--muted')
    expect(after).not.toBe(before)
  })
})

it('keeps workbench edits while another tab is open', async () => {
  renderDevTools()

  fireEvent.click(screen.getByRole('button', { name: 'DEV' }))
  fireEvent.click(screen.getByRole('tab', { name: 'Themes' }))
  fireEvent.click(screen.getByRole('button', { name: 'Surfaces' }))

  const input = sliderInput('Muted')
  fireEvent.change(input, { target: { value: '30' } })

  await waitFor(() => {
    expect(screen.getByText('30%')).toBeInTheDocument()
  })

  fireEvent.click(screen.getByRole('tab', { name: 'Holidays' }))

  expect(screen.getByText('10-31')).toBeInTheDocument()
  expect(localStorage.getItem('syrnike13-prism-workbench:v1')).toContain('30')
})

it('previews the other mode from the panel and restores the saved mode on close', async () => {
  renderDevTools()

  fireEvent.click(screen.getByRole('button', { name: 'DEV' }))
  fireEvent.click(screen.getByRole('tab', { name: 'Themes' }))

  fireEvent.click(screen.getByRole('button', { name: 'Light' }))

  await waitFor(() => {
    expect(document.documentElement.dataset.themeResolved).toBe('light')
  })

  fireEvent.click(screen.getByRole('button', { name: 'Close dev tools' }))

  await waitFor(() => {
    expect(document.documentElement.dataset.themeResolved).toBe('dark')
  })
})

it('persists the holiday preview through the provider storage key', async () => {
  const storageKey = 'holiday-override-overlay-test'

  const { unmount } = renderDevTools(storageKey)

  fireEvent.click(screen.getByRole('button', { name: 'DEV' }))
  fireEvent.click(screen.getByRole('button', { name: 'День Победы' }))

  expect(localStorage.getItem(storageKey)).toBe('victory-day')

  unmount()

  renderDevTools(storageKey)

  fireEvent.click(screen.getByRole('button', { name: 'DEV' }))

  await waitFor(() => {
    expect(screen.getByText('День Победы · dev override')).toBeInTheDocument()
  })
})

it('changes only the Home icon when previewing Halloween', () => {
  renderDevTools()

  const icons = screen.getByTestId('product-icons')
  const halloweenIcons = Array.from(
    icons.querySelectorAll('svg'),
    (icon) => icon.innerHTML,
  )

  fireEvent.click(screen.getByRole('button', { name: 'DEV' }))
  fireEvent.click(screen.getByRole('button', { name: 'Off' }))

  const ordinaryIcons = Array.from(
    icons.querySelectorAll('svg'),
    (icon) => icon.innerHTML,
  )
  expect(halloweenIcons[0]).not.toBe(ordinaryIcons[0])
  expect(halloweenIcons.slice(1)).toEqual(ordinaryIcons.slice(1))

  fireEvent.click(screen.getByRole('button', { name: 'Хэллоуин' }))

  expect(
    Array.from(icons.querySelectorAll('svg'), (icon) => icon.innerHTML),
  ).toEqual(halloweenIcons)
  expect(document.documentElement.dataset.holiday).toBeUndefined()
})
