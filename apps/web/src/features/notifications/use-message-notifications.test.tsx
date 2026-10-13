// @vitest-environment jsdom

import { act, cleanup, render } from '@testing-library/react'
import type { Channel, Member, Message, User } from '@syrnike13/api-types'
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

  function mentionsOnly() {
    syncStore.setChannelNotificationLevel('text-general', 'mentions')
  }

  function addCurrentMember(roles: string[]) {
    syncStore.upsertMembers([
      {
        _id: { server: 'server-1', user: mocks.currentUserId },
        joined_at: '2024-01-01T00:00:00Z',
        roles,
      } as Member,
    ])
  }

  function addCurrentUser(online: boolean) {
    syncStore.upsertUser({
      _id: mocks.currentUserId,
      username: 'alice',
      discriminator: '0001',
      relationship: 'User',
      online,
    } as User)
  }

  it('notifies a mentions-only channel on @everyone', () => {
    mentionsOnly()
    render(<Probe />)

    emit(message({ flags: 1 << 2 }))

    expect(mocks.notify).toHaveBeenCalledOnce()
  })

  it('does not treat other flag bits as a mention', () => {
    mentionsOnly()
    render(<Probe />)

    // MentionsEveryone = 2 — индекс бита, маска 1 << 2. Значение 2 — это бит 1.
    emit(message({ flags: 2 }))

    expect(mocks.notify).not.toHaveBeenCalled()
  })

  it('notifies a mentions-only channel when one of my roles is mentioned', () => {
    mentionsOnly()
    addCurrentMember(['role-1'])
    render(<Probe />)

    emit(message({ role_mentions: ['role-1'] }))

    expect(mocks.notify).toHaveBeenCalledOnce()
  })

  it('keeps quiet when the mentioned role is not mine', () => {
    mentionsOnly()
    addCurrentMember(['role-2'])
    render(<Probe />)

    emit(message({ role_mentions: ['role-1'] }))

    expect(mocks.notify).not.toHaveBeenCalled()
  })

  it('notifies a mentions-only channel on @online while the user is online', () => {
    mentionsOnly()
    addCurrentUser(true)
    render(<Probe />)

    emit(message({ flags: 1 << 3 }))

    expect(mocks.notify).toHaveBeenCalledOnce()
  })

  it('keeps quiet on @online while the user is offline', () => {
    mentionsOnly()
    addCurrentUser(false)
    render(<Probe />)

    emit(message({ flags: 1 << 3 }))

    expect(mocks.notify).not.toHaveBeenCalled()
  })

  it('keeps quiet on @everyone when the channel level is none', () => {
    syncStore.setChannelNotificationLevel('text-general', 'none')
    render(<Probe />)

    emit(message({ flags: 1 << 2 }))

    expect(mocks.notify).not.toHaveBeenCalled()
  })

  it('does not apply role mentions to a direct message', () => {
    const dm = {
      _id: 'dm-1',
      channel_type: 'DirectMessage',
      active: true,
      recipients: [mocks.currentUserId, AUTHOR_ID],
    } as Channel
    syncStore.upsertChannel(dm)
    syncStore.setChannelNotificationLevel('dm-1', 'mentions')
    addCurrentMember(['role-1'])
    render(<Probe />)

    emit(message({ channel: 'dm-1', role_mentions: ['role-1'] }))

    expect(mocks.notify).not.toHaveBeenCalled()
  })

  it('notifies on any message while the level is all', () => {
    addCurrentMember(['role-2'])
    render(<Probe />)

    emit(message({ role_mentions: ['role-1'] }))

    expect(mocks.notify).toHaveBeenCalledOnce()
  })
})
