// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { ServerSettingsInvitesPanel } from '#/components/servers/server-settings-invites-panel'
import { syncStore } from '#/features/sync/sync-store'
import { ChannelPermission } from '#/lib/permissions'
import { permissionOr } from '#/lib/permission-bits'

const mocks = vi.hoisted(() => ({
  fetchServerInvites: vi.fn(),
  createChannelInvite: vi.fn(),
  deleteInvite: vi.fn(),
  writeClipboardText: vi.fn(),
}))

vi.mock('sonner', () => ({
  toast: {
    error: vi.fn(),
    success: vi.fn(),
  },
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

vi.mock('#/lib/clipboard', () => ({
  writeClipboardText: (...args: Parameters<typeof mocks.writeClipboardText>) =>
    mocks.writeClipboardText(...args),
}))

function renderWithQuery(children: ReactNode) {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
    },
  })

  return render(
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>,
  )
}

describe('ServerSettingsInvitesPanel', () => {
  beforeEach(() => {
    syncStore.reset()
    syncStore.upsertServer({
      _id: 'server-1',
      name: 'Server',
      owner: 'owner-1',
      channels: ['channel-1'],
      default_permissions: ChannelPermission.ViewChannel,
    } as never)
    syncStore.upsertChannel({
      _id: 'channel-1',
      channel_type: 'TextChannel',
      server: 'server-1',
      name: 'general',
    } as never)
    syncStore.upsertMembers([
      {
        _id: { server: 'server-1', user: 'user-1' },
        joined_at: '2024-01-01T00:00:00Z',
      } as never,
    ])
    mocks.fetchServerInvites.mockResolvedValue([
      {
        type: 'Server',
        _id: 'invite-code',
        server: 'server-1',
        channel: 'channel-1',
        creator: 'user-1',
        created_at: 0,
        expires_at: null,
        max_uses: null,
        uses: 2,
        revoked_at: null,
        revoked_by: null,
        temporary: false,
      },
    ])
    mocks.createChannelInvite.mockResolvedValue({ _id: 'new-code' })
    mocks.deleteInvite.mockResolvedValue(undefined)
    mocks.writeClipboardText.mockResolvedValue(undefined)
  })

  afterEach(() => {
    cleanup()
    syncStore.reset()
    vi.clearAllMocks()
  })

  it('revokes an invite through the invites API', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true)

    renderWithQuery(<ServerSettingsInvitesPanel serverId="server-1" />)

    expect(await screen.findByText('invite-code')).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: 'Отозвать' }))

    await waitFor(() => {
      expect(mocks.deleteInvite).toHaveBeenCalledWith(
        'session-token',
        'invite-code',
      )
    })
  })

  it('creates invites in the first channel that grants InviteOthers', async () => {
    syncStore.upsertServer({
      _id: 'server-1',
      name: 'Server',
      owner: 'owner-1',
      channels: ['channel-1', 'channel-2'],
      default_permissions: ChannelPermission.ViewChannel,
    } as never)
    syncStore.upsertChannel({
      _id: 'channel-2',
      channel_type: 'TextChannel',
      server: 'server-1',
      name: 'invites',
      default_permissions: {
        a: permissionOr(
          ChannelPermission.ViewChannel,
          ChannelPermission.InviteOthers,
        ),
        d: 0,
      },
    } as never)

    renderWithQuery(<ServerSettingsInvitesPanel serverId="server-1" />)

    await screen.findByText('invite-code')
    fireEvent.click(screen.getByRole('button', { name: 'Создать' }))

    await waitFor(() => {
      expect(mocks.createChannelInvite).toHaveBeenCalledWith(
        'session-token',
        'channel-2',
        {
          max_age_seconds: 604800,
          max_uses: 0,
          temporary: false,
        },
      )
    })
  })

  it('creates invites in the selected channel', async () => {
    syncStore.upsertServer({
      _id: 'server-1',
      name: 'Server',
      owner: 'owner-1',
      channels: ['channel-1', 'channel-2'],
      default_permissions: permissionOr(
        ChannelPermission.ViewChannel,
        ChannelPermission.InviteOthers,
      ),
    } as never)
    syncStore.upsertChannel({
      _id: 'channel-2',
      channel_type: 'TextChannel',
      server: 'server-1',
      name: 'rules',
    } as never)

    renderWithQuery(<ServerSettingsInvitesPanel serverId="server-1" />)

    await screen.findByText('invite-code')
    fireEvent.change(screen.getByLabelText('Канал приглашения'), {
      target: { value: 'channel-2' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Создать' }))

    await waitFor(() => {
      expect(mocks.createChannelInvite).toHaveBeenCalledWith(
        'session-token',
        'channel-2',
        {
          max_age_seconds: 604800,
          max_uses: 0,
          temporary: false,
        },
      )
    })
  })

  it('copies an existing invite link', async () => {
    renderWithQuery(<ServerSettingsInvitesPanel serverId="server-1" />)

    expect(await screen.findByText('invite-code')).toBeTruthy()
    fireEvent.click(
      screen.getByRole('button', { name: 'Копировать invite-code' }),
    )

    await waitFor(() => {
      expect(mocks.writeClipboardText).toHaveBeenCalledWith(
        expect.stringContaining('/invite/invite-code'),
      )
    })
  })

  it('shows the target channel for existing invites', async () => {
    syncStore.upsertServer({
      _id: 'server-1',
      name: 'Server',
      owner: 'owner-1',
      channels: ['channel-1', 'channel-2'],
      default_permissions: ChannelPermission.ViewChannel,
    } as never)
    syncStore.upsertChannel({
      _id: 'channel-2',
      channel_type: 'TextChannel',
      server: 'server-1',
      name: 'rules',
    } as never)
    mocks.fetchServerInvites.mockResolvedValue([
      {
        type: 'Server',
        _id: 'rules-code',
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

    renderWithQuery(<ServerSettingsInvitesPanel serverId="server-1" />)

    expect(await screen.findByText('rules-code')).toBeTruthy()
    expect(screen.getByText(/#rules/)).toBeTruthy()
  })
})
