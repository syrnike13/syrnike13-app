// @vitest-environment jsdom

import { StrictMode } from 'react'
import { render, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { VoiceStagePopout } from '#/components/voice/voice-stage-popout'

function childWindowStub() {
  const childDocument = document.implementation.createHTMLDocument('popout')
  let closed = false
  const childWindow = {
    document: childDocument,
    close: vi.fn(() => {
      closed = true
    }),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  }
  Object.defineProperty(childWindow, 'closed', {
    configurable: true,
    get: () => closed,
  })

  return {
    childDocument,
    childWindow: childWindow as unknown as Window,
    closeChildWindow: () => {
      closed = true
    },
  }
}

describe('VoiceStagePopout', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
    delete document.documentElement.dataset.theme
    delete document.documentElement.dataset.themeGradient
  })

  it('renders into the child window without closing it on React cleanup', () => {
    const { childDocument, childWindow } = childWindowStub()
    const close = vi.fn()

    const { unmount } = render(
      <StrictMode>
        <VoiceStagePopout
          childWindow={childWindow}
          title="Demo"
          onClose={close}
        >
          <span>Stream</span>
        </VoiceStagePopout>
      </StrictMode>,
    )

    expect(childDocument.body.textContent).toContain('Stream')

    unmount()

    expect(childWindow.close).not.toHaveBeenCalled()
    expect(close).not.toHaveBeenCalled()
  })

  it('notifies onClose when the user closes the child window', () => {
    const { childWindow, closeChildWindow } = childWindowStub()
    const close = vi.fn()

    render(
      <VoiceStagePopout
        childWindow={childWindow}
        title="Demo"
        onClose={close}
      >
        <span>Stream</span>
      </VoiceStagePopout>,
    )

    closeChildWindow()
    vi.advanceTimersByTime(500)

    expect(close).toHaveBeenCalledTimes(1)
    expect(childWindow.close).not.toHaveBeenCalled()
  })

  it('keeps gradient appearance attributes in sync while open', async () => {
    vi.useRealTimers()
    const { childDocument, childWindow } = childWindowStub()
    document.documentElement.dataset.theme = 'gradient-demo'
    document.documentElement.dataset.themeGradient = 'aurora'

    const { unmount } = render(
      <VoiceStagePopout
        childWindow={childWindow}
        title="Demo"
        onClose={vi.fn()}
      >
        <span>Stream</span>
      </VoiceStagePopout>,
    )

    expect(childDocument.documentElement.dataset.themeGradient).toBe('aurora')

    document.documentElement.dataset.themeGradient = 'sunset'
    await waitFor(() => {
      expect(childDocument.documentElement.dataset.themeGradient).toBe('sunset')
    })

    delete document.documentElement.dataset.themeGradient
    await waitFor(() => {
      expect(
        childDocument.documentElement.hasAttribute('data-theme-gradient'),
      ).toBe(false)
    })

    unmount()
  })
})
