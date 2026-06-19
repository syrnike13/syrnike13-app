// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
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
      channels: ['channel-1'],
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
    syncStore.upsertMembers([
      {
        _id: { server: 'server-1', user: 'user-1' },
        joined_at: '2024-01-01T00:00:00Z',
      } as never,
    ])
    mocks.createChannelInvite.mockResolvedValue({ _id: 'new-code' })
    mocks.deleteInvite.mockResolvedValue(undefined)
    mocks.fetchServerInvites.mockResolvedValue([])
    mocks.writeClipboardText.mockResolvedValue(undefined)
  })

  afterEach(() => {
    cleanup()
    syncStore.reset()
    vi.clearAllMocks()
  })

  it('creates an invite with expiry, usage limit, and temporary membership', async () => {
    render(
      <ServerInviteDialog
        serverId="server-1"
        open
        onOpenChange={vi.fn()}
      />,
    )

    fireEvent.change(screen.getByLabelText('Срок действия'), {
      target: { value: '86400' },
    })
    fireEvent.change(screen.getByLabelText('Максимум использований'), {
      target: { value: '10' },
    })
    fireEvent.click(screen.getByLabelText('Временное членство'))
    fireEvent.click(
      screen.getByRole('button', { name: 'Создать и скопировать ссылку' }),
    )

    await waitFor(() => {
      expect(mocks.createChannelInvite).toHaveBeenCalledWith(
        'session-token',
        'channel-1',
        {
          max_age_seconds: 86400,
          max_uses: 10,
          temporary: true,
        },
      )
    })
  })
})
