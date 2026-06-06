import { afterEach, describe, expect, it, vi } from 'vitest'

import { subscribeDesktopBridge } from '#/platform/use-platform'

describe('subscribeDesktopBridge', () => {
  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it('stops polling after the desktop bridge appears', () => {
    vi.useFakeTimers()
    const windowStub = {
      setInterval: globalThis.setInterval,
      clearInterval: globalThis.clearInterval,
    } as Window & typeof globalThis
    vi.stubGlobal('window', windowStub)

    const onStoreChange = vi.fn()
    const unsubscribe = subscribeDesktopBridge(onStoreChange)

    vi.advanceTimersByTime(50)
    expect(onStoreChange).toHaveBeenCalledTimes(0)

    windowStub.syrnikeDesktop = {} as never
    vi.advanceTimersByTime(50)
    vi.advanceTimersByTime(500)

    unsubscribe()
    expect(onStoreChange).toHaveBeenCalledTimes(1)
  })
})
