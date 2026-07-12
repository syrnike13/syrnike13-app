// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { AnchorHTMLAttributes, ReactNode } from 'react'
import { forwardRef } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { ServerRail } from '#/components/layout/server-rail'
import { syncStore } from '#/features/sync/sync-store'

vi.mock('@tanstack/react-router', () => ({
  Link: forwardRef<
    HTMLAnchorElement,
    AnchorHTMLAttributes<HTMLAnchorElement> & {
      children: ReactNode
      to: string
    }
  >(({ children, to, ...props }, ref) => (
    <a ref={ref} href={to} {...props}>
      {children}
    </a>
  )),
  useMatch: ({ from }: { from: string }) =>
    from === '/app/' || from === '/m/'
      ? { routeId: from, params: {}, search: {} }
      : false,
}))

vi.mock('#/features/auth/auth-context', () => ({
  useAuth: () => ({
    session: { token: 'session-token' },
    user: { _id: 'current-user', username: 'me' },
  }),
}))

vi.mock('#/platform/use-platform', () => ({
  usePlatform: () => ({
    capabilities: { customWindowChrome: false },
  }),
}))

vi.mock('#/components/servers/create-server-dialog', () => ({
  CreateServerDialog: () => null,
}))

describe('ServerRail', () => {
  beforeEach(() => {
    syncStore.reset()
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
          _id: 'request-1',
          username: 'bob',
          discriminator: '0002',
          relationship: 'Incoming',
          online: true,
        },
      ],
      servers: [],
      channels: [],
      members: [],
      emojis: [],
      channel_unreads: [],
      voice_states: [],
    } as never)
  })

  afterEach(() => {
    cleanup()
    syncStore.reset()
  })

  it('shows home notifications on the home rail button', () => {
    render(<ServerRail variant="desktop" />)

    expect(screen.getByTitle('Главная')).toBeTruthy()
    expect(screen.getByText('1')).toBeTruthy()
  })

  it('does not count unread direct messages on the home badge', () => {
    syncStore.reset()
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
          username: 'alice',
          discriminator: '0002',
          relationship: 'Friend',
          online: true,
        },
      ],
      servers: [],
      channels: [
        {
          _id: 'dm-1',
          channel_type: 'DirectMessage',
          active: true,
          recipients: ['current-user', 'friend-1'],
          last_message_id: 'message-2',
        },
      ],
      members: [],
      emojis: [],
      channel_unreads: [
        {
          _id: { channel: 'dm-1' },
          last_id: 'message-1',
        },
      ],
      voice_states: [],
    } as never)

    render(<ServerRail variant="desktop" />)

    const home = screen.getByTitle('Главная')
    expect(screen.getByTitle('alice')).toBeTruthy()
    expect(home.querySelector('[data-slot="badge"]')).toBeNull()
  })

  it('does not show people when there are no unread messages or calls', () => {
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
          username: 'alice',
          discriminator: '0002',
          relationship: 'Friend',
          online: true,
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
      members: [],
      emojis: [],
      channel_unreads: [
        {
          _id: { channel: 'dm-1' },
          last_id: 'message-1',
        },
      ],
      voice_states: [],
    } as never)

    render(<ServerRail variant="desktop" />)

    expect(screen.queryByTitle('alice')).toBeNull()
  })

  it('shows people under home when a direct message is unread', () => {
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
          username: 'alice',
          discriminator: '0002',
          relationship: 'Friend',
          online: true,
        },
      ],
      servers: [
        {
          _id: 'server-1',
          name: 'Demo',
          owner: 'current-user',
          channels: [],
        },
      ],
      channels: [
        {
          _id: 'dm-1',
          channel_type: 'DirectMessage',
          active: true,
          recipients: ['current-user', 'friend-1'],
          last_message_id: 'message-2',
        },
        {
          _id: 'text-1',
          channel_type: 'TextChannel',
          server: 'server-1',
          name: 'general',
          last_message_id: null,
        },
      ],
      members: [],
      emojis: [],
      channel_unreads: [
        {
          _id: { channel: 'dm-1' },
          last_id: 'message-1',
        },
      ],
      voice_states: [],
    } as never)

    render(<ServerRail variant="desktop" />)

    const home = screen.getByTitle('Главная')
    const person = screen.getByTitle('alice')
    const server = screen.getByTitle('Demo')

    expect(home.compareDocumentPosition(person) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(person.compareDocumentPosition(server) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })

  it('clears selectedServerId when opening a person from the rail', () => {
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
          username: 'alice',
          discriminator: '0002',
          relationship: 'Friend',
          online: true,
        },
      ],
      servers: [],
      channels: [
        {
          _id: 'dm-1',
          channel_type: 'DirectMessage',
          active: true,
          recipients: ['current-user', 'friend-1'],
          last_message_id: 'message-2',
        },
      ],
      members: [],
      emojis: [],
      channel_unreads: [
        {
          _id: { channel: 'dm-1' },
          last_id: 'message-1',
        },
      ],
      voice_states: [],
    } as never)
    syncStore.setSelectedServerId('server-1')

    render(<ServerRail variant="desktop" />)

    fireEvent.click(screen.getByTitle('alice'))

    expect(syncStore.getState().selectedServerId).toBeNull()
  })

  it('shows a rail unread indicator instead of a badge on servers', () => {
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
      servers: [
        {
          _id: 'server-1',
          name: 'Demo',
          owner: 'current-user',
          channels: [],
        },
      ],
      channels: [
        {
          _id: 'text-1',
          channel_type: 'TextChannel',
          server: 'server-1',
          name: 'general',
          last_message_id: 'message-2',
        },
      ],
      members: [],
      emojis: [],
      channel_unreads: [
        {
          _id: { channel: 'text-1' },
          last_id: 'message-1',
        },
      ],
      voice_states: [],
    } as never)

    render(<ServerRail variant="desktop" />)

    const serverLink = screen.getByTitle('Demo')
    const serverRow = serverLink.closest('.group')
    const indicator = serverRow?.querySelector('[data-slot="rail-indicator"]')

    expect(indicator).toBeTruthy()
    expect(indicator?.hasAttribute('data-unread')).toBe(true)
    expect(indicator?.className).toContain('h-4')
    expect(indicator?.className).toContain('opacity-100')
    expect(indicator?.className).not.toMatch(/transition-\[height,opacity\]/)
    expect(serverLink.querySelector('[data-slot="badge"]')).toBeNull()
  })

  it('keeps the unread rail indicator visible without hover', () => {
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
      servers: [
        {
          _id: 'server-1',
          name: 'Demo',
          owner: 'current-user',
          channels: [],
        },
      ],
      channels: [
        {
          _id: 'text-1',
          channel_type: 'TextChannel',
          server: 'server-1',
          name: 'general',
          last_message_id: 'message-2',
        },
      ],
      members: [],
      emojis: [],
      channel_unreads: [
        {
          _id: { channel: 'text-1' },
          last_id: 'message-1',
        },
      ],
      voice_states: [],
    } as never)

    render(<ServerRail variant="desktop" />)

    const serverRow = screen.getByTitle('Demo').closest('.group')
    const indicator = serverRow?.querySelector('[data-slot="rail-indicator"]')

    fireEvent.mouseLeave(serverRow!)

    expect(indicator?.className).toContain('opacity-100')
    expect(indicator?.className).not.toContain('opacity-0')
  })
})
