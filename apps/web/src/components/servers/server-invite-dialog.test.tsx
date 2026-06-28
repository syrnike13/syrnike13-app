// @vitest-environment jsdom

import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react'
import type { ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { ServerInviteDialog } from '#/components/servers/server-invite-dialog'
import { syncStore } from '#/features/sync/sync-store'
import { ChannelPermission } from '#/lib/permissions'
import { permissionOr } from '#/lib/permission-bits'

const mocks = vi.hoisted(() => ({
  createChannelInvite: vi.fn(),
  deleteInvite: vi.fn(),
  fetchServerInvites: vi.fn(),
  openDirectMessage: vi.fn(),
  sendChannelMessage: vi.fn(),
  writeClipboardText: vi.fn(),
}))

vi.mock('sonner', () => ({
  toast: {
    error: vi.fn(),
    success: vi.fn(),
  },
}))

vi.mock('#/components/ui/dialog', () => ({
  Dialog: ({ open, children }: { open: boolean; children: ReactNode }) =>
    open ? <div>{children}</div> : null,
  DialogContent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DialogHeader: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DialogTitle: ({ children }: { children: ReactNode }) => <h2>{children}</h2>,
}))

vi.mock('#/features/auth/auth-context', () => ({
  useAuth: () => ({
    session: { token: 'session-token' },
    user: { _id: 'user-1', username: 'alice' },
  }),
}))

vi.mock('#/features/api/servers-api', () => ({
  fetchServerInvites: (...args: Parameters<typeof mocks.fetchServerInvites>) =>
    mocks.fetchServerInvites(...args),
}))

vi.mock('#/features/api/invites-api', () => ({
  createChannelInvite: (...args: Parameters<typeof mocks.createChannelInvite>) =>
    mocks.createChannelInvite(...args),
  deleteInvite: (...args: Parameters<typeof mocks.deleteInvite>) =>
    mocks.deleteInvite(...args),
}))

vi.mock('#/features/api/messages-api', () => ({
  sendChannelMessage: (...args: Parameters<typeof mocks.sendChannelMessage>) =>
    mocks.sendChannelMessage(...args),
}))

vi.mock('#/features/api/users-api', () => ({
  openDirectMessage: (...args: Parameters<typeof mocks.openDirectMessage>) =>
    mocks.openDirectMessage(...args),
}))

vi.mock('#/lib/clipboard', () => ({
  writeClipboardText: (...args: Parameters<typeof mocks.writeClipboardText>) =>
    mocks.writeClipboardText(...args),
}))

describe('ServerInviteDialog', () => {
  beforeEach(() => {
    syncStore.reset()
    syncStore.upsertServer({
      _id: 'server-1',
      name: 'Server',
      owner: 'owner-1',
      channels: ['channel-1', 'channel-2'],
      default_permissions: ChannelPermission.ViewChannel,
    } as never)
    syncStore.upsertChannel({
      _id: 'channel-1',
      channel_type: 'TextChannel',
      server: 'server-1',
      name: 'general',
      default_permissions: {
        a: permissionOr(
          ChannelPermission.ViewChannel,
          ChannelPermission.InviteOthers,
        ),
        d: 0,
      },
    } as never)
    syncStore.upsertChannel({
      _id: 'channel-2',
      channel_type: 'TextChannel',
      server: 'server-1',
      name: 'announcements',
      default_permissions: {
        a: permissionOr(
          ChannelPermission.ViewChannel,
          ChannelPermission.InviteOthers,
        ),
        d: 0,
      },
    } as never)
    syncStore.upsertMembers([
      {
        _id: { server: 'server-1', user: 'user-1' },
        joined_at: '2024-01-01T00:00:00Z',
      } as never,
    ])
    syncStore.upsertUsers([
      {
        _id: 'user-1',
        username: 'alice',
        display_name: 'Alice',
        relationship: 'User',
      } as never,
      {
        _id: 'friend-1',
        username: 'bob',
        display_name: 'Bob',
        relationship: 'Friend',
      } as never,
      {
        _id: 'bot-1',
        username: 'bot',
        display_name: 'Bot',
        relationship: 'Friend',
        bot: { owner: 'user-1' },
      } as never,
    ])
    mocks.createChannelInvite.mockResolvedValue({ _id: 'new-code' })
    mocks.deleteInvite.mockResolvedValue(undefined)
    mocks.fetchServerInvites.mockResolvedValue([])
    mocks.openDirectMessage.mockResolvedValue({
      _id: 'dm-1',
      channel_type: 'DirectMessage',
      recipients: ['user-1', 'friend-1'],
    })
    mocks.sendChannelMessage.mockResolvedValue({
      _id: 'message-1',
      channel: 'dm-1',
      author: 'user-1',
      content: 'https://syrnike13.ru/invite/new-code',
    })
    mocks.writeClipboardText.mockResolvedValue(undefined)
  })

  afterEach(() => {
    cleanup()
    syncStore.reset()
    vi.clearAllMocks()
  })

  it('loads existing invites when rendered open', async () => {
    syncStore.upsertServer({
      _id: 'server-1',
      name: 'Server',
      owner: 'user-1',
      channels: ['channel-1', 'channel-2'],
      default_permissions: ChannelPermission.ViewChannel,
    } as never)
    mocks.fetchServerInvites.mockResolvedValue([
      {
        type: 'Server',
        _id: 'existing-code',
        server: 'server-1',
        channel: 'channel-1',
        creator: 'user-1',
        created_at: 0,
        expires_at: null,
        max_uses: null,
        uses: 0,
        revoked_at: null,
        revoked_by: null,
        temporary: false,
      },
    ])

    render(
      <ServerInviteDialog
        serverId="server-1"
        open
        onOpenChange={vi.fn()}
      />,
    )

    expect(await screen.findByText(/existing-code/)).toBeTruthy()
    expect(mocks.fetchServerInvites).toHaveBeenCalledWith(
      'session-token',
      'server-1',
    )
  })

  it('shows the target channel for existing invites', async () => {
    syncStore.upsertServer({
      _id: 'server-1',
      name: 'Server',
      owner: 'user-1',
      channels: ['channel-1', 'channel-2'],
      default_permissions: ChannelPermission.ViewChannel,
    } as never)
    mocks.fetchServerInvites.mockResolvedValue([
      {
        type: 'Server',
        _id: 'announcements-code',
        server: 'server-1',
        channel: 'channel-2',
        creator: 'user-1',
        created_at: 0,
        expires_at: null,
        max_uses: null,
        uses: 0,
        revoked_at: null,
        revoked_by: null,
        temporary: false,
      },
    ])

    render(
      <ServerInviteDialog
        serverId="server-1"
        open
        onOpenChange={vi.fn()}
      />,
    )

    expect(await screen.findByText(/announcements-code/)).toBeTruthy()
    expect(screen.getByText('announcements')).toBeTruthy()
  })

  it('creates an invite with expiry and usage limit', async () => {
    render(
      <ServerInviteDialog
        serverId="server-1"
        open
        onOpenChange={vi.fn()}
      />,
    )

    fireEvent.click(
      screen.getByRole('button', { name: /Изменить ссылку-приглашение/ }),
    )
    fireEvent.change(screen.getByLabelText('Срок действия'), {
      target: { value: '86400' },
    })
    fireEvent.change(screen.getByLabelText('Максимум использований'), {
      target: { value: '10' },
    })
    expect(screen.queryByLabelText('Временное членство')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: /Копировать/ }))

    await waitFor(() => {
      expect(mocks.createChannelInvite).toHaveBeenCalledWith(
        'session-token',
        'channel-1',
        {
          max_age_seconds: 86400,
          max_uses: 10,
        },
      )
    })
  })

  it('creates an invite for the selected channel', async () => {
    render(
      <ServerInviteDialog
        serverId="server-1"
        open
        onOpenChange={vi.fn()}
      />,
    )

    fireEvent.click(
      screen.getByRole('button', { name: /Изменить ссылку-приглашение/ }),
    )
    fireEvent.change(screen.getByLabelText('Канал приглашения'), {
      target: { value: 'channel-2' },
    })
    fireEvent.click(screen.getByRole('button', { name: /Копировать/ }))

    await waitFor(() => {
      expect(mocks.createChannelInvite).toHaveBeenCalledWith(
        'session-token',
        'channel-2',
        {
          max_age_seconds: 2592000,
          max_uses: 0,
        },
      )
    })
  })

  it('sends an invite link to a selected friend through DM', async () => {
    render(
      <ServerInviteDialog
        serverId="server-1"
        open
        onOpenChange={vi.fn()}
      />,
    )

    expect(await screen.findByText('Bob')).toBeTruthy()
    expect(screen.queryByText('Bot')).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: 'Пригласить Bob' }))

    await waitFor(() => {
      expect(mocks.createChannelInvite).toHaveBeenCalledWith(
        'session-token',
        'channel-1',
        {
          max_age_seconds: 2592000,
          max_uses: 0,
        },
      )
      expect(mocks.openDirectMessage).toHaveBeenCalledWith(
        'session-token',
        'friend-1',
      )
      expect(mocks.sendChannelMessage).toHaveBeenCalledWith(
        'session-token',
        'dm-1',
        {
          content:
            'Приглашение на сервер Server: https://syrnike13.ru/invite/new-code',
        },
      )
    })
  })
})
