// @vitest-environment jsdom

import { act, cleanup, render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { MessageList } from '#/components/chat/message-list'
import { syncStore } from '#/features/sync/sync-store'

const CHANNEL_ID = '01KT7DEM3B0T4B0BXGBXWDJ700'
const USER_ID = '01KT7DEM3B0T4B0BXGBXWDJ701'
const MESSAGE_ID = '01KT7DEM3B0T4B0BXGBXWDJ702'

type IntersectionCallback = ConstructorParameters<
  typeof IntersectionObserver
>[0]

class FakeIntersectionObserver {
  readonly callback: IntersectionCallback

  constructor(callback: IntersectionCallback) {
    this.callback = callback
    intersectionObservers.push(this)
  }

  observe = vi.fn()
  disconnect = vi.fn()
  unobserve = vi.fn()
  takeRecords = vi.fn(() => [])

  trigger(isIntersecting: boolean) {
    this.callback(
      [{ isIntersecting } as IntersectionObserverEntry],
      this as unknown as IntersectionObserver,
    )
  }
}

class FakeResizeObserver {
  observe = vi.fn()
  disconnect = vi.fn()
  unobserve = vi.fn()
}

let intersectionObservers: FakeIntersectionObserver[] = []

function renderMessageList(onLoadOlder: () => void) {
  return render(
    <MessageList
      channelId={CHANNEL_ID}
      messages={[
        {
          _id: MESSAGE_ID,
          channel: CHANNEL_ID,
          author: USER_ID,
          content: 'hello',
          user: {
            _id: USER_ID,
            username: 'alice',
            discriminator: '0001',
            relationship: 'None',
            online: true,
          },
        },
      ] as never}
      users={{
        [USER_ID]: {
          _id: USER_ID,
          username: 'alice',
          discriminator: '0001',
          relationship: 'None',
          online: true,
        },
      }}
      hasOlder
      loadingOlder={false}
      onLoadOlder={onLoadOlder}
    />,
  )
}

describe('MessageList older history loading', () => {
  beforeEach(() => {
    syncStore.reset()
    intersectionObservers = []
    vi.useFakeTimers()
    vi.stubGlobal('IntersectionObserver', FakeIntersectionObserver)
    vi.stubGlobal('ResizeObserver', FakeResizeObserver)
  })

  afterEach(() => {
    cleanup()
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it('does not load older messages before the user scrolls away from the tail', () => {
    const onLoadOlder = vi.fn()
    const view = renderMessageList(onLoadOlder)
    const root = view.container.firstElementChild as HTMLDivElement
    Object.defineProperties(root, {
      clientHeight: { configurable: true, value: 400 },
      scrollHeight: { configurable: true, value: 1_000 },
    })

    act(() => {
      vi.runOnlyPendingTimers()
      intersectionObservers.at(-1)?.trigger(true)
    })

    expect(onLoadOlder).not.toHaveBeenCalled()
  })

  it('loads older messages when the initial history does not fill the viewport', () => {
    const onLoadOlder = vi.fn()
    const view = renderMessageList(onLoadOlder)
    const root = view.container.firstElementChild as HTMLDivElement
    Object.defineProperties(root, {
      clientHeight: { configurable: true, value: 400 },
      scrollHeight: { configurable: true, value: 300 },
    })

    act(() => {
      intersectionObservers.at(-1)?.trigger(true)
    })

    expect(onLoadOlder).toHaveBeenCalledOnce()
  })

  it('loads older messages after the user scrolls away from the tail', () => {
    const onLoadOlder = vi.fn()
    const view = renderMessageList(onLoadOlder)
    const root = view.container.firstElementChild as HTMLDivElement
    Object.defineProperties(root, {
      clientHeight: { configurable: true, value: 400 },
      scrollHeight: { configurable: true, value: 1_000 },
    })

    act(() => {
      root.scrollTop = 100
      root.dispatchEvent(new Event('scroll'))
      intersectionObservers.at(-1)?.trigger(true)
    })

    expect(onLoadOlder).toHaveBeenCalledOnce()
  })
})
