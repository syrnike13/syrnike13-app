// @vitest-environment jsdom

import { StrictMode } from 'react'
import { render } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { VoiceStagePopout } from '#/components/voice/voice-stage-popout'

function childWindowStub() {
  const childDocument = document.implementation.createHTMLDocument('popout')
  const listeners = new Map<string, EventListener>()
  const childWindow = {
    document: childDocument,
    closed: false,
    close: vi.fn(() => {
      childWindow.closed = true
    }),
    addEventListener: vi.fn((type: string, listener: EventListener) => {
      listeners.set(type, listener)
    }),
    removeEventListener: vi.fn((type: string) => {
      listeners.delete(type)
    }),
  }

  return {
    childDocument,
    childWindow: childWindow as unknown as Window,
  }
}

describe('VoiceStagePopout', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(new Response())))
  })

  it('closes the child window during React effect cleanup', () => {
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

    expect(childWindow.close).toHaveBeenCalled()
  })
})
