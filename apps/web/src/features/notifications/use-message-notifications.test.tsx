// @vitest-environment jsdom

import { act, cleanup, render } from '@testing-library/react'
import type { Channel, Message, User } from '@syrnike13/api-types'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { useMessageNotifications } from '#/features/notifications/use-message-notifications'
import { syncStore } from '#/features/sync/sync-store'

const mocks = vi.hoisted(() => ({
  handler: null as null | ((event: unknown) => void),
  notify: vi.fn(),
  currentUserId: 'user-current',
}))

vi.mock('#/features/events/gateway', () => ({
  eventsGateway: {
    subscribeServerEvents: (handler: (event: unknown) => void) => {
      mocks.handler = handler
      return () => {
        mocks.handler = null
      }
    },
  },
}))

vi.mock('#/features/auth/auth-context', () => ({
  useAuth: () => ({
    session: { token: 'session-token' },
    user: { _id: mocks.currentUserId, username: 'alice' },
  }),
}))

const AUTHOR_ID = 'user-author'

class FakeNotification {
  static permission: NotificationPermission = 'granted'
  onclick: (() => void) | null = null

  constructor(title: string, options?: NotificationOptions) {
    mocks.notify(title, options)
  }

  close() {}
}

const CHANNEL = {
  _id: 'text-general',
  channel_type: 'TextChannel',
  server: 'server-1',
  name: 'general',
} as Channel

function message(overrides: Partial<Message> = {}): Message {
  return {
    type: 'Message',
    _id: 'message-1',
    channel: 'text-general',
    author: AUTHOR_ID,
    content: 'привет',
    ...overrides,
  } as Message
}

function Probe() {
  useMessageNotifications()
  return null
}

describe('useMessageNotifications local mutes', () => {
  beforeEach(() => {
    syncStore.reset()
    mocks.handler = null
    mocks.notify.mockClear()
    vi.stubGlobal('Notification', FakeNotification)
    vi.spyOn(document, 'hasFocus').mockReturnValue(false)
    syncStore.upsertChannel(CHANNEL)
    syncStore.upsertUser({
      _id: AUTHOR_ID,
      username: 'bob',
      discriminator: '0002',
      relationship: 'Friend',
      online: true,
    } as User)
  })

  afterEach(() => {
    cleanup()
    syncStore.reset()
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  function emit(event: unknown) {
    act(() => {
      mocks.handler?.(event)
    })
  }

  it('creates a notification for an unmuted channel', () => {
    render(<Probe />)

    emit(message())

    expect(mocks.notify).toHaveBeenCalledOnce()
  })

  it('keeps quiet when the channel is muted', () => {
    syncStore.setChannelMute('text-general', 'forever')
    render(<Probe />)

    emit(message())

    expect(mocks.notify).not.toHaveBeenCalled()
  })

  it('keeps quiet on a mentions-only channel without a mention', () => {
    syncStore.setChannelNotificationLevel('text-general', 'mentions')
    render(<Probe />)

    emit(message())

    expect(mocks.notify).not.toHaveBeenCalled()
  })

  it('notifies a mentions-only channel when the user is mentioned', () => {
    syncStore.setChannelNotificationLevel('text-general', 'mentions')
    render(<Probe />)

    emit(message({ mentions: [mocks.currentUserId] }))

    expect(mocks.notify).toHaveBeenCalledOnce()
  })
})
