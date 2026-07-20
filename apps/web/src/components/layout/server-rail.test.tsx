// @vitest-environment jsdom

import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react'
import type { AnchorHTMLAttributes, ReactNode } from 'react'
import { forwardRef } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { ServerRail } from '#/components/layout/server-rail'
import { syncStore } from '#/features/sync/sync-store'
import { ChannelPermission } from '#/features/authorization/authorization'
import { serverIconUrl } from '#/lib/media'

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
  useLinkProps: ({
    to,
    params,
    search: _search,
    ...props
  }: {
    to: string
    params?: { channelId?: string }
    search?: Record<string, unknown>
  } & AnchorHTMLAttributes<HTMLAnchorElement>) => ({
    ...props,
    href: params?.channelId
      ? to.replace('$channelId', params.channelId)
      : to,
  }),
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
    vi.unstubAllGlobals()
  })

  it('shows home notifications on the home rail button', () => {
    const { container } = render(<ServerRail variant="desktop" />)

    expect(screen.getByRole('link', { name: 'Главная' })).toBeTruthy()
    expect(screen.getByText('1')).toBeTruthy()
    expect(container.firstElementChild?.classList.contains('pt-1')).toBe(true)
    expect(container.firstElementChild?.classList.contains('pb-3')).toBe(true)
    expect(container.firstElementChild?.classList.contains('py-3')).toBe(false)
  })

  it('shows a server icon when the server has one', () => {
    const icon = {
      _id: 'server-icon-1',
      tag: 'icons',
      filename: 'server.png',
      content_type: 'image/png',
      metadata: {
        type: 'Image',
        width: 128,
        height: 128,
      },
    } as const

    syncStore.applyReady({
      users: [],
      servers: [
        {
          _id: 'server-1',
          name: 'Demo',
          owner: 'current-user',
          channels: [],
          default_permissions: 0,
          icon,
        },
      ],
      channels: [],
      members: [],
      emojis: [],
      channel_unreads: [],
      voice_states: [],
    } as never)

    render(<ServerRail variant="desktop" />)

    const image = screen
      .getByRole('link', { name: 'Demo' })
      .querySelector('img')

    expect(image?.getAttribute('src')).toBe(serverIconUrl(icon as never))
    expect(image?.className).toContain('object-cover')
    expect(screen.queryByText('DE')).toBeNull()
  })

  it('shows the server name without a configured tooltip delay', async () => {
    syncStore.applyReady({
      users: [],
      servers: [
        {
          _id: 'server-1',
          name: 'Demo',
          owner: 'current-user',
          channels: [],
          default_permissions: 0,
        },
      ],
      channels: [],
      members: [],
      emojis: [],
      channel_unreads: [],
      voice_states: [],
    } as never)

    render(<ServerRail variant="desktop" />)

    fireEvent.pointerMove(screen.getByRole('link', { name: 'Demo' }), {
      pointerType: 'mouse',
    })

    await waitFor(() => {
      const tooltip = screen.getByRole('tooltip')
      const tooltipContent = document.querySelector(
        '[data-slot="tooltip-content"]',
      )
      expect(tooltip.textContent).toBe('Demo')
      expect(tooltipContent?.className).toContain('font-black')
      expect(tooltipContent?.firstElementChild?.className).toContain('w-max')
      expect(tooltipContent?.firstElementChild?.className).not.toContain(
        'min-w-32',
      )
    })
  })

  it('separates voice participants and screen sharers in the server tooltip', async () => {
    const voiceUserId = '01VOICEUSERALICE00000001'
    const screenSharingUserId = '01VOICEUSERBOB0000000002'
    const voiceParticipant = {
      id: voiceUserId,
      joined_at: 1,
      self_mute: false,
      self_deaf: false,
      server_muted: false,
      server_deafened: false,
      screensharing: false,
      camera: false,
      version: 1,
    }
    const screenSharingParticipant = {
      id: screenSharingUserId,
      joined_at: 2,
      self_mute: false,
      self_deaf: false,
      server_muted: false,
      server_deafened: false,
      screensharing: true,
      camera: false,
      version: 1,
    }

    syncStore.applyReady({
      authorization: {
        revision: 1,
        global: 0,
        servers: { 'server-1': ChannelPermission.ViewChannel },
        channels: { 'voice-1': ChannelPermission.ViewChannel },
        users: {},
      },
      users: [
        {
          _id: voiceUserId,
          username: 'alice',
          discriminator: '0001',
          relationship: 'User',
          online: true,
        },
        {
          _id: screenSharingUserId,
          username: 'bob',
          discriminator: '0002',
          relationship: 'User',
          online: true,
        },
      ],
      servers: [
        {
          _id: 'server-1',
          name: 'Demo',
          owner: 'current-user',
          channels: ['voice-1'],
          default_permissions: 0,
        },
      ],
      channels: [
        {
          _id: 'voice-1',
          channel_type: 'TextChannel',
          server: 'server-1',
          name: 'Voice',
          voice: { max_users: null },
          last_message_id: null,
        },
      ],
      members: [],
      emojis: [],
      channel_unreads: [],
      voice_states: [
        {
          id: 'voice-1',
          participants: [voiceParticipant, screenSharingParticipant],
        },
      ],
      voice_calls: [],
    } as never)

    render(<ServerRail variant="desktop" />)

    const serverLink = screen.getByRole('link', { name: 'Demo' })
    const activityBadge = serverLink.querySelector<HTMLElement>(
      '[data-slot="server-activity-badge"]',
    )
    expect(activityBadge?.dataset.kind).toBe('screen-share')
    expect(activityBadge?.hasAttribute('data-connected')).toBe(false)
    expect(activityBadge?.getAttribute('aria-label')).toBe(
      'На сервере демонстрируют экран',
    )

    fireEvent.pointerMove(serverLink, {
      pointerType: 'mouse',
    })

    await waitFor(() => {
      const tooltipContent = document.querySelector<HTMLElement>(
        '[data-slot="tooltip-content"]',
      )
      expect(tooltipContent).toBeTruthy()

      const voiceRow = tooltipContent!.querySelector<HTMLElement>(
        ':scope > div > [data-slot="server-rail-tooltip-row"][data-kind="voice"]',
      )
      const screenShareRow = tooltipContent!.querySelector<HTMLElement>(
        ':scope > div > [data-slot="server-rail-tooltip-row"][data-kind="screen-share"]',
      )
      expect(voiceRow).toBeTruthy()
      expect(screenShareRow).toBeTruthy()

      expect(within(voiceRow!).getByTitle('alice')).toBeTruthy()
      expect(within(voiceRow!).queryByTitle('bob')).toBeNull()
      expect(within(screenShareRow!).getByTitle('bob')).toBeTruthy()
      expect(within(screenShareRow!).queryByTitle('alice')).toBeNull()
    })

    syncStore.setChannelVoiceParticipants('voice-1', [voiceParticipant])

    await waitFor(() => {
      const voiceBadge = serverLink.querySelector<HTMLElement>(
        '[data-slot="server-activity-badge"]',
      )
      expect(voiceBadge?.dataset.kind).toBe('voice')
      expect(voiceBadge?.getAttribute('aria-label')).toBe(
        'На сервере есть участники голосовых каналов',
      )
    })
  })

  it('animates a GIF server icon only while the rail item is interactive', () => {
    const icon = {
      _id: 'server-icon-gif',
      tag: 'icons',
      filename: 'server.gif',
      content_type: 'image/gif',
      metadata: {
        type: 'Image',
        width: 128,
        height: 128,
        animated: true,
      },
    } as const

    syncStore.applyReady({
      users: [],
      servers: [
        {
          _id: 'server-1',
          name: 'Demo',
          owner: 'current-user',
          channels: [],
          default_permissions: 0,
          icon,
        },
      ],
      channels: [],
      members: [],
      emojis: [],
      channel_unreads: [],
      voice_states: [],
    } as never)

    render(<ServerRail variant="desktop" />)

    const serverLink = screen.getByRole('link', { name: 'Demo' })
    const image = serverLink.querySelector('img')

    expect(image?.getAttribute('src')).toBe(serverIconUrl(icon as never))

    fireEvent.pointerEnter(serverLink)
    expect(image?.getAttribute('src')).toBe(
      serverIconUrl(icon as never, { animated: true }),
    )

    fireEvent.pointerLeave(serverLink)
    expect(image?.getAttribute('src')).toBe(serverIconUrl(icon as never))

    fireEvent.focus(serverLink)
    expect(image?.getAttribute('src')).toBe(
      serverIconUrl(icon as never, { animated: true }),
    )

    fireEvent.blur(serverLink)
    expect(image?.getAttribute('src')).toBe(serverIconUrl(icon as never))
  })

  it('keeps a GIF server icon static when reduced motion is enabled', async () => {
    const mediaListener = vi.fn()
    vi.stubGlobal(
      'matchMedia',
      vi.fn(() => ({
        matches: true,
        addEventListener: mediaListener,
        removeEventListener: vi.fn(),
      })),
    )
    const icon = {
      _id: 'server-icon-gif',
      tag: 'icons',
      filename: 'server.gif',
      content_type: 'image/gif',
      metadata: {
        type: 'Image',
        width: 128,
        height: 128,
        animated: true,
      },
    } as const

    syncStore.applyReady({
      users: [],
      servers: [
        {
          _id: 'server-1',
          name: 'Demo',
          owner: 'current-user',
          channels: [],
          default_permissions: 0,
          icon,
        },
      ],
      channels: [],
      members: [],
      emojis: [],
      channel_unreads: [],
      voice_states: [],
    } as never)

    render(<ServerRail variant="desktop" />)
    await waitFor(() => expect(mediaListener).toHaveBeenCalled())

    const serverLink = screen.getByRole('link', { name: 'Demo' })
    const image = serverLink.querySelector('img')

    fireEvent.pointerEnter(serverLink)
    fireEvent.focus(serverLink)

    expect(image?.getAttribute('src')).toBe(serverIconUrl(icon as never))
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

    const home = screen.getByRole('link', { name: 'Главная' })
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

    const home = screen.getByRole('link', { name: 'Главная' })
    const person = screen.getByTitle('alice')
    const server = screen.getByRole('link', { name: 'Demo' })

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
      authorization: {
        revision: 1,
        global: 0,
        servers: { 'server-1': ChannelPermission.ViewChannel },
        channels: { 'text-1': ChannelPermission.ViewChannel },
        users: {},
      },
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

    const serverLink = screen.getByRole('link', { name: 'Demo' })
    const serverRow = serverLink.closest('.group')
    const indicator = serverRow?.querySelector('[data-slot="rail-indicator"]')

    expect(indicator).toBeTruthy()
    expect(indicator?.hasAttribute('data-unread')).toBe(true)
    expect(indicator?.className).toContain('h-2')
    expect(indicator?.className).toContain('opacity-100')
    expect(indicator?.className).not.toMatch(/transition-\[height,opacity\]/)
    expect(serverLink.querySelector('[data-slot="badge"]')).toBeNull()
  })

  it('keeps the unread rail indicator visible without hover', () => {
    syncStore.applyReady({
      authorization: {
        revision: 1,
        global: 0,
        servers: { 'server-1': ChannelPermission.ViewChannel },
        channels: { 'text-1': ChannelPermission.ViewChannel },
        users: {},
      },
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

    const serverRow = screen
      .getByRole('link', { name: 'Demo' })
      .closest('.group')
    const indicator = serverRow?.querySelector('[data-slot="rail-indicator"]')

    fireEvent.mouseLeave(serverRow!)

    expect(indicator?.className).toContain('opacity-100')
    expect(indicator?.className).not.toContain('opacity-0')
  })
})
