// @vitest-environment jsdom

import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  LOADING_EASTER_EGG_PREVIEW_MS,
  useLoadingEasterEggPreviewGate,
} from '#/components/layout/gateway-loading-easter-egg'
import { GatewayLoadingScreen } from '#/components/layout/gateway-loading-screen'
import { easterModeStore } from '#/features/easter/easter-mode-store'
import { APP_LOGO_SRC, APP_NAME } from '#/lib/brand'

const LOADING_EASTER_EGG_SRC = '/loading-easter-egg-alpha.png'

function PreviewGateProbe() {
  const ready = useLoadingEasterEggPreviewGate()
  return <span data-testid="preview-ready">{String(ready)}</span>
}

describe('GatewayLoadingScreen easter egg', () => {
  beforeEach(() => {
    localStorage.clear()
    easterModeStore.setEnabled(false)
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      callback(0)
      return 1
    })
    vi.stubGlobal('cancelAnimationFrame', vi.fn())
  })

  afterEach(() => {
    cleanup()
    easterModeStore.setEnabled(false)
    vi.restoreAllMocks()
    vi.useRealTimers()
    vi.unstubAllGlobals()
    localStorage.clear()
    delete (
      window as Window & {
        __syrnikeLoadingEasterEggPreviewStartedAt?: number
      }
    ).__syrnikeLoadingEasterEggPreviewStartedAt
  })

  it('shows the app logo on the regular loading path', () => {
    const { container } = render(
      <GatewayLoadingScreen gatewayState="connecting" />,
    )

    const logo = screen.getByRole('img', { name: APP_NAME })

    expect(logo.getAttribute('src')).toBe(APP_LOGO_SRC)
    expect(container.querySelector(`[src="${LOADING_EASTER_EGG_SRC}"]`)).toBeNull()
  })

  it('shows the loading animation when easter mode is enabled', () => {
    easterModeStore.setEnabled(true)

    const { container } = render(
      <GatewayLoadingScreen gatewayState="connecting" />,
    )

    const animation = container.querySelector(`[src="${LOADING_EASTER_EGG_SRC}"]`)

    expect(animation?.tagName).toBe('IMG')
    expect(animation?.getAttribute('alt')).toBe(APP_NAME)
    expect(animation?.getAttribute('src')).toBe(LOADING_EASTER_EGG_SRC)
  })

  it('keeps easter loading visible long enough to see the animation', () => {
    vi.useFakeTimers()
    easterModeStore.setEnabled(true)

    render(<PreviewGateProbe />)

    expect(screen.getByTestId('preview-ready').textContent).toBe('false')

    act(() => {
      vi.advanceTimersByTime(LOADING_EASTER_EGG_PREVIEW_MS - 1)
    })

    expect(screen.getByTestId('preview-ready').textContent).toBe('false')

    act(() => {
      vi.advanceTimersByTime(1)
    })

    expect(screen.getByTestId('preview-ready').textContent).toBe('true')
  })

  it('does not delay loading dismissal outside easter mode', () => {
    render(<PreviewGateProbe />)

    expect(screen.getByTestId('preview-ready').textContent).toBe('true')
  })

  it('renders the loading animation at its source size when there is room', () => {
    easterModeStore.setEnabled(true)

    const { container } = render(
      <GatewayLoadingScreen gatewayState="connecting" />,
    )

    const animation = container.querySelector(`[src="${LOADING_EASTER_EGG_SRC}"]`)

    expect(animation?.getAttribute('width')).toBe('512')
    expect(animation?.getAttribute('height')).toBe('512')
    expect(animation?.className).toContain(
      'size-[min(32rem,calc(100vw-3rem))]',
    )
    expect(animation?.parentElement?.className).toContain('max-w-[32rem]')
  })

  it('falls back to the logo if the loading animation cannot load', async () => {
    easterModeStore.setEnabled(true)

    const { container } = render(
      <GatewayLoadingScreen gatewayState="connecting" />,
    )

    await waitFor(() => {
      expect(container.querySelector(`[src="${LOADING_EASTER_EGG_SRC}"]`)).toBeTruthy()
    })

    const animation = container.querySelector(`[src="${LOADING_EASTER_EGG_SRC}"]`)

    if (animation === null) {
      throw new Error('Expected loading easter egg animation to render')
    }

    fireEvent.error(animation)

    expect(screen.getByRole('img', { name: APP_NAME })).toBeTruthy()
    expect(container.querySelector(`[src="${LOADING_EASTER_EGG_SRC}"]`)).toBeNull()
  })
})
