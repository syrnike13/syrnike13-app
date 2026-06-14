// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest'

import { writeClipboardText } from './clipboard'

function stubNavigatorClipboard(writeText: ReturnType<typeof vi.fn>) {
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: { writeText },
  })
}

describe('writeClipboardText', () => {
  afterEach(() => {
    window.syrnikeDesktop = undefined
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: undefined,
    })
    vi.restoreAllMocks()
  })

  it('uses the Electron desktop bridge instead of navigator.clipboard', async () => {
    const desktopWriteText = vi.fn().mockResolvedValue(undefined)
    const browserWriteText = vi
      .fn()
      .mockRejectedValue(new Error('Clipboard window is not available'))
    stubNavigatorClipboard(browserWriteText)
    window.syrnikeDesktop = {
      runtime: 'desktop',
      platform: { os: 'win32' },
      clipboard: { writeText: desktopWriteText },
    } as never

    await writeClipboardText('message-id-1')

    expect(desktopWriteText).toHaveBeenCalledWith('message-id-1')
    expect(browserWriteText).not.toHaveBeenCalled()
  })

  it('uses navigator.clipboard in the browser runtime', async () => {
    const browserWriteText = vi.fn().mockResolvedValue(undefined)
    stubNavigatorClipboard(browserWriteText)

    await writeClipboardText('message-id-2')

    expect(browserWriteText).toHaveBeenCalledWith('message-id-2')
  })
})
