// @vitest-environment node

import { readFileSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'

type PushHandler = (event: {
  data?: {
    json: () => unknown
    text?: () => string
  }
  waitUntil: (promise: Promise<unknown>) => void
}) => void

type NotificationClickHandler = (event: {
  notification: {
    data?: {
      url?: string
    }
    close: () => void
  }
  waitUntil: (promise: Promise<unknown>) => void
}) => void

function loadServiceWorker() {
  const source = readFileSync(
    new URL('../../../public/sw.js', import.meta.url),
    'utf8',
  )
  const listeners = new Map<string, PushHandler | NotificationClickHandler>()
  const activeNotification = { close: vi.fn() }
  const openedWindow = { focus: vi.fn(() => Promise.resolve()) }
  const selfMock = {
    addEventListener: vi.fn(
      (type: string, handler: PushHandler | NotificationClickHandler) => {
      listeners.set(type, handler)
      },
    ),
    skipWaiting: vi.fn(() => Promise.resolve()),
    clients: {
      claim: vi.fn(() => Promise.resolve()),
      matchAll: vi.fn(() => Promise.resolve([])),
      openWindow: vi.fn(() => Promise.resolve(openedWindow)),
    },
    registration: {
      showNotification: vi.fn(() => Promise.resolve()),
      getNotifications: vi.fn(() => Promise.resolve([activeNotification])),
    },
  }
  const cachesMock = {
    keys: vi.fn(() => Promise.resolve([])),
    delete: vi.fn(() => Promise.resolve(true)),
  }

  new Function('self', 'caches', source)(selfMock, cachesMock)

  return {
    pushHandler: listeners.get('push') as PushHandler | undefined,
    notificationClickHandler: listeners.get('notificationclick') as
      | NotificationClickHandler
      | undefined,
    activeNotification,
    clients: selfMock.clients,
    openedWindow,
    registration: selfMock.registration,
  }
}

function pushEvent(payload: unknown) {
  let pending: Promise<unknown> | undefined

  return {
    data: {
      json: () => payload,
    },
    waitUntil: vi.fn((promise: Promise<unknown>) => {
      pending = promise
    }),
    waitForPush: async () => {
      await pending
    },
  }
}

describe('service worker push handler', () => {
  it('shows incoming call notifications with a channel click target', async () => {
    const { pushHandler, registration } = loadServiceWorker()
    const event = pushEvent({
      type: 'DmCallStartEnd',
      channel_id: 'dm-1',
      ended: false,
      tag: 'voice-call:dm-1',
      title: 'syrnike13',
      body: 'Alice is calling you',
    })

    expect(pushHandler).toBeTypeOf('function')
    pushHandler?.(event)
    await event.waitForPush()

    expect(registration.showNotification).toHaveBeenCalledWith(
      'syrnike13',
      expect.objectContaining({
        body: 'Alice is calling you',
        tag: 'voice-call:dm-1',
        data: {
          url: '/app/c/dm-1',
        },
      }),
    )
  })

  it('closes call notifications without showing a new notification when the call ended', async () => {
    const { pushHandler, activeNotification, registration } =
      loadServiceWorker()
    const event = pushEvent({
      type: 'DmCallStartEnd',
      channel_id: 'dm-1',
      ended: true,
      tag: 'voice-call:dm-1',
    })

    expect(pushHandler).toBeTypeOf('function')
    pushHandler?.(event)
    await event.waitForPush()

    expect(registration.getNotifications).toHaveBeenCalledWith({
      tag: 'voice-call:dm-1',
    })
    expect(activeNotification.close).toHaveBeenCalledTimes(1)
    expect(registration.showNotification).not.toHaveBeenCalled()
  })

  it('opens the channel target when a call notification is clicked', async () => {
    const { notificationClickHandler, clients, openedWindow } =
      loadServiceWorker()
    let pending: Promise<unknown> | undefined
    const notification = {
      data: {
        url: '/app/c/dm-1',
      },
      close: vi.fn(),
    }

    expect(notificationClickHandler).toBeTypeOf('function')
    notificationClickHandler?.({
      notification,
      waitUntil: (promise) => {
        pending = promise
      },
    })
    await pending

    expect(notification.close).toHaveBeenCalledTimes(1)
    expect(clients.openWindow).toHaveBeenCalledWith('/app/c/dm-1')
    expect(openedWindow.focus).toHaveBeenCalledTimes(1)
  })
})
