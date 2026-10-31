// @vitest-environment jsdom

import { act, cleanup, fireEvent, render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { MessageList } from '#/components/chat/message-list'
import { syncStore } from '@syrnike13/client/sync/sync-store'

const CHANNEL_ID = '01KT7DEM3B0T4B0BXGBXWDJ700'
const USER_ID = '01KT7DEM3B0T4B0BXGBXWDJ701'
const FIRST_MESSAGE_ID = '01KT7DEM3B0T4B0BXGBXWDJ702'
const SECOND_MESSAGE_ID = '01KT7DEM3B0T4B0BXGBXWDJ703'

const user = {
  _id: USER_ID,
  username: 'alice',
  discriminator: '0001',
  relationship: 'None' as const,
  online: true,
}

function message(id: string, content = 'hello') {
  return {
    _id: id,
    channel: CHANNEL_ID,
    author: USER_ID,
    content,
    user,
  }
}

function renderMessageList(
  onLoadOlder: () => void,
  scrollPaddingBottom?: number,
  messages = [message(FIRST_MESSAGE_ID)],
) {
  return render(
    <MessageList
      channelId={CHANNEL_ID}
      messages={messages as never}
      users={{ [USER_ID]: user }}
      hasOlder
      loadingOlder={false}
      onLoadOlder={onLoadOlder}
      scrollPaddingBottom={scrollPaddingBottom}
    />,
  )
}

function viewportOf(container: HTMLElement) {
  return container.querySelector(
    '[data-slot="message-scroller-viewport"]',
  ) as HTMLDivElement
}

describe('MessageList older history loading', () => {
  beforeEach(() => {
    syncStore.reset()
    vi.stubGlobal(
      'ResizeObserver',
      class {
        observe = vi.fn()
        disconnect = vi.fn()
        unobserve = vi.fn()
      },
    )
    vi.stubGlobal(
      'IntersectionObserver',
      class {
        observe = vi.fn()
        disconnect = vi.fn()
        unobserve = vi.fn()
        takeRecords = vi.fn(() => [])
      },
    )
  })

  afterEach(() => {
    cleanup()
    vi.unstubAllGlobals()
  })

  it('does not load older messages while the feed stays at the tail', () => {
    const onLoadOlder = vi.fn()
    const view = renderMessageList(onLoadOlder)
    const viewport = viewportOf(view.container)

    Object.defineProperties(viewport, {
      clientHeight: { configurable: true, value: 400 },
      scrollHeight: { configurable: true, value: 1_000 },
    })

    act(() => {
      viewport.scrollTop = 600
      fireEvent.scroll(viewport)
    })

    expect(onLoadOlder).not.toHaveBeenCalled()
  })

  it('loads older messages when the initial history does not fill the viewport', () => {
    const onLoadOlder = vi.fn()
    const view = renderMessageList(onLoadOlder)
    const viewport = viewportOf(view.container)

    Object.defineProperties(viewport, {
      clientHeight: { configurable: true, value: 400 },
      scrollHeight: { configurable: true, value: 300 },
    })

    view.rerender(
      <MessageList
        channelId={CHANNEL_ID}
        messages={
          [
            message(FIRST_MESSAGE_ID),
            message(SECOND_MESSAGE_ID, 'second'),
          ] as never
        }
        users={{ [USER_ID]: user }}
        hasOlder
        loadingOlder={false}
        onLoadOlder={onLoadOlder}
      />,
    )

    expect(onLoadOlder).toHaveBeenCalledOnce()
  })

  it('loads older messages after the user scrolls to the top', () => {
    const onLoadOlder = vi.fn()
    const view = renderMessageList(onLoadOlder)
    const viewport = viewportOf(view.container)

    Object.defineProperties(viewport, {
      clientHeight: { configurable: true, value: 400 },
      scrollHeight: { configurable: true, value: 1_000 },
    })

    act(() => {
      viewport.scrollTop = 0
      fireEvent.scroll(viewport)
    })

    expect(onLoadOlder).toHaveBeenCalledOnce()
  })

  it('reserves the measured composer height instead of a fixed utility', () => {
    const view = renderMessageList(vi.fn(), 236)
    const scroller = view.container.querySelector(
      '[data-slot="message-scroller"]',
    ) as HTMLDivElement

    expect(scroller.style.getPropertyValue('--scroll-padding')).toBe('236px')
  })
})

describe('MessageList unread marker', () => {
  beforeEach(() => {
    syncStore.reset()
    vi.stubGlobal(
      'ResizeObserver',
      class {
        observe = vi.fn()
        disconnect = vi.fn()
        unobserve = vi.fn()
      },
    )
    vi.stubGlobal(
      'IntersectionObserver',
      class {
        observe = vi.fn()
        disconnect = vi.fn()
        unobserve = vi.fn()
        takeRecords = vi.fn(() => [])
      },
    )
  })

  afterEach(() => {
    cleanup()
    vi.unstubAllGlobals()
  })

  it('marks the first unread message as the scroll anchor', () => {
    syncStore.setChannelLastRead(CHANNEL_ID, FIRST_MESSAGE_ID)

    const view = renderMessageList(vi.fn(), undefined, [
      message(FIRST_MESSAGE_ID),
      message(SECOND_MESSAGE_ID, 'unread'),
    ])

    expect(view.getByRole('separator', { name: 'Новые сообщения' })).toBeTruthy()

    const anchor = view.container.querySelector(
      `[data-message-id="${SECOND_MESSAGE_ID}"][data-scroll-anchor="true"]`,
    )
    expect(anchor).toBeTruthy()
  })
})
