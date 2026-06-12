// @vitest-environment jsdom

import { cleanup, render, screen } from '@testing-library/react'
import type { AnchorHTMLAttributes, ReactNode } from 'react'
import { forwardRef } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { DmChannelList } from '#/components/home/dm-channel-list'
import { syncStore } from '#/features/sync/sync-store'

vi.mock('@tanstack/react-router', () => ({
  Link: forwardRef<
    HTMLAnchorElement,
    AnchorHTMLAttributes<HTMLAnchorElement> & {
      children: ReactNode
      params?: Record<string, string>
      to: string
    }
  >(({ children, params, to, ...props }, ref) => {
    const href = to === '/app/c/$channelId'
      ? `/app/c/${params?.channelId ?? ''}`
      : to

    return (
      <a ref={ref} href={href} {...props}>
        {children}
      </a>
    )
  }),
}))

vi.mock('#/features/auth/auth-context', () => ({
  useAuth: () => ({
    session: { token: 'session-token' },
    user: { _id: 'current-user', username: 'me' },
  }),
}))

describe('DmChannelList', () => {
  beforeEach(() => {
    syncStore.reset()
  })

  afterEach(() => {
    cleanup()
    syncStore.reset()
  })

  it('shows a read direct message after the first message exists', () => {
    syncStore.applyReady({
      users: [
        {
          _id: 'current-user',
          username: 'me',
          discriminator: '0001',
          relationship: 'User',
          online: true,
        },
        {
          _id: 'friend-1',
          username: 'test_isa',
          discriminator: '0002',
          relationship: 'Friend',
          online: false,
        },
      ],
      servers: [],
      channels: [
        {
          _id: 'dm-1',
          channel_type: 'DirectMessage',
          active: true,
          recipients: ['current-user', 'friend-1'],
          last_message_id: 'message-1',
        },
      ],
      channel_unreads: [
        {
          _id: { channel: 'dm-1' },
          last_id: 'message-1',
        },
      ],
      members: [],
      emojis: [],
      voice_states: [],
    } as never)

    render(<DmChannelList activeChannelId="dm-1" />)

    expect(screen.getByRole('link', { name: /test_isa/i })).toBeTruthy()
    expect(screen.queryByText('Нет личных сообщений')).toBeNull()
  })

  it('renders group direct messages with a group icon', () => {
    syncStore.applyReady({
      users: [
        {
          _id: 'current-user',
          username: 'me',
          discriminator: '0001',
          relationship: 'User',
          online: true,
        },
      ],
      servers: [],
      channels: [
        {
          _id: 'group-1',
          channel_type: 'Group',
          active: true,
          name: 'Команда',
          owner: 'current-user',
          recipients: ['current-user', 'friend-1', 'friend-2'],
          last_message_id: 'message-1',
        },
      ],
      channel_unreads: [
        {
          _id: { channel: 'group-1' },
          last_id: 'message-1',
        },
      ],
      members: [],
      emojis: [],
      voice_states: [],
    } as never)

    render(<DmChannelList activeChannelId="group-1" />)

    expect(screen.getByRole('link', { name: /Команда/i })).toBeTruthy()
    expect(screen.getByTitle('Групповой чат')).toBeTruthy()
  })

  it('marks incoming calls in the direct message list', () => {
    syncStore.applyReady({
      users: [
        {
          _id: 'current-user',
          username: 'me',
          discriminator: '0001',
          relationship: 'User',
          online: true,
        },
        {
          _id: 'friend-1',
          username: 'test_isa',
          discriminator: '0002',
          relationship: 'Friend',
          online: false,
        },
      ],
      servers: [],
      channels: [
        {
          _id: 'dm-1',
          channel_type: 'DirectMessage',
          active: true,
          recipients: ['current-user', 'friend-1'],
          last_message_id: 'message-1',
        },
      ],
      channel_unreads: [],
      members: [],
      emojis: [],
      voice_states: [],
    } as never)
    syncStore.setVoiceCall({
      channelId: 'dm-1',
      initiatorId: 'friend-1',
      phase: 'ringing',
      startedAt: '2026-06-12T10:00:00.000Z',
      recipients: ['current-user'],
      declinedRecipients: [],
    })

    render(<DmChannelList />)

    expect(screen.getByTitle('Входящий звонок')).toBeTruthy()
  })

  it('does not mark dismissed incoming calls in the direct message list', () => {
    const call = {
      channelId: 'dm-1',
      initiatorId: 'friend-1',
      phase: 'ringing' as const,
      startedAt: '2026-06-12T10:00:00.000Z',
      recipients: ['current-user'],
      declinedRecipients: [],
    }
    syncStore.applyReady({
      users: [
        {
          _id: 'current-user',
          username: 'me',
          discriminator: '0001',
          relationship: 'User',
          online: true,
        },
        {
          _id: 'friend-1',
          username: 'test_isa',
          discriminator: '0002',
          relationship: 'Friend',
          online: false,
        },
      ],
      servers: [],
      channels: [
        {
          _id: 'dm-1',
          channel_type: 'DirectMessage',
          active: true,
          recipients: ['current-user', 'friend-1'],
          last_message_id: 'message-1',
        },
      ],
      channel_unreads: [],
      members: [],
      emojis: [],
      voice_states: [],
    } as never)
    syncStore.setVoiceCall(call)
    syncStore.dismissVoiceCall(call)

    render(<DmChannelList />)

    expect(screen.queryByTitle('Входящий звонок')).toBeNull()
  })

  it('does not mark active calls after hiding the same ringing phase', () => {
    const ringingCall = {
      channelId: 'dm-1',
      initiatorId: 'friend-1',
      phase: 'ringing' as const,
      startedAt: '2026-06-12T10:00:00.000Z',
      recipients: ['current-user'],
      declinedRecipients: [],
    }
    syncStore.applyReady({
      users: [
        {
          _id: 'current-user',
          username: 'me',
          discriminator: '0001',
          relationship: 'User',
          online: true,
        },
        {
          _id: 'friend-1',
          username: 'test_isa',
          discriminator: '0002',
          relationship: 'Friend',
          online: false,
        },
      ],
      servers: [],
      channels: [
        {
          _id: 'dm-1',
          channel_type: 'DirectMessage',
          active: true,
          recipients: ['current-user', 'friend-1'],
          last_message_id: 'message-1',
        },
      ],
      channel_unreads: [],
      members: [],
      emojis: [],
      voice_states: [],
    } as never)
    syncStore.dismissVoiceCall(ringingCall)
    syncStore.setVoiceCall({
      ...ringingCall,
      phase: 'active',
      recipients: [],
    })

    render(<DmChannelList />)

    expect(screen.queryByTitle('Идёт звонок')).toBeNull()
  })
})
