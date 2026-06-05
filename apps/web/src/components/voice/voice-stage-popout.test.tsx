// @vitest-environment jsdom

import { StrictMode } from 'react'
import { render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { VoiceStagePopout } from '#/components/voice/voice-stage-popout'

function childWindowStub() {
  const childDocument = document.implementation.createHTMLDocument('popout')
  const childWindow = {
    document: childDocument,
    closed: false,
    close: vi.fn(() => {
      childWindow.closed = true
    }),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  }

  return {
    childDocument,
    childWindow: childWindow as unknown as Window,
  }
}

describe('VoiceStagePopout', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
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
    const { childWindow } = childWindowStub()
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

    childWindow.closed = true
    vi.advanceTimersByTime(500)

    expect(close).toHaveBeenCalledTimes(1)
    expect(childWindow.close).not.toHaveBeenCalled()
  })
})
