import '@testing-library/jest-dom/vitest'

import { cleanup } from '@testing-library/react'
import { configureDefaultCatalogs } from '@syrnike13/ui/i18n'
import { afterEach, vi } from 'vitest'

import en from '#/messages/en.json'
import ru from '#/messages/ru.json'

configureDefaultCatalogs({ en, ru })

afterEach(() => {
  cleanup()
})

if (typeof Element !== 'undefined' && !Element.prototype.scrollIntoView) {
  Element.prototype.scrollIntoView = vi.fn()
}

if (typeof Element !== 'undefined' && !Element.prototype.getAnimations) {
  Element.prototype.getAnimations = () => []
}

if (typeof window !== 'undefined') {
  if (!window.matchMedia) {
    Object.defineProperty(window, 'matchMedia', {
      writable: true,
      value: vi.fn().mockImplementation((query: string) => ({
        matches: false,
        media: query,
        onchange: null,
        addListener: vi.fn(),
        removeListener: vi.fn(),
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        dispatchEvent: vi.fn(),
      })),
    })
  }

  if (!globalThis.ResizeObserver) {
    class ResizeObserverStub {
      observe() {}
      unobserve() {}
      disconnect() {}
    }

    globalThis.ResizeObserver = ResizeObserverStub
  }

  if (!globalThis.IntersectionObserver) {
    class IntersectionObserverStub {
      observe() {}
      unobserve() {}
      disconnect() {}
      takeRecords() {
        return []
      }
    }

    globalThis.IntersectionObserver =
      IntersectionObserverStub as unknown as typeof IntersectionObserver
  }
}
