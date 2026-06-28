// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react'
import type { ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { ServerSettingsInvitesPanel } from '#/components/servers/server-settings-invites-panel'
import { syncStore } from '#/features/sync/sync-store'
import { ChannelPermission } from '#/lib/permissions'

const mocks = vi.hoisted(() => ({
  fetchServerInvites: vi.fn(),
  deleteInvite: vi.fn(),
  serverInviteDialog: vi.fn(),
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
  deleteInvite: (...args: Parameters<typeof mocks.deleteInvite>) =>
    mocks.deleteInvite(...args),
}))

vi.mock('#/lib/clipboard', () => ({
  writeClipboardText: (...args: Parameters<typeof mocks.writeClipboardText>) =>
    mocks.writeClipboardText(...args),
}))

vi.mock('#/components/servers/server-invite-dialog', () => ({
  ServerInviteDialog: (props: {
    serverId: string
    open: boolean
    onOpenChange: (open: boolean) => void
  }) => {
    mocks.serverInviteDialog(props)
    return props.open ? (
      <div role="dialog">
        <span>invite dialog for {props.serverId}</span>
        <button type="button" onClick={() => props.onOpenChange(false)}>
          Закрыть приглашение
        </button>
      </div>
    ) : null
  },
}))

vi.mock('#/components/ui/dialog', () => ({
  Dialog: ({ open, children }: { open: boolean; children: ReactNode }) =>
    open ? <div role="dialog">{children}</div> : null,
  DialogContent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DialogDescription: ({ children }: { children: ReactNode }) => (
    <p>{children}</p>
  ),
  DialogFooter: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DialogHeader: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DialogTitle: ({ children }: { children: ReactNode }) => <h2>{children}</h2>,
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
    mocks.deleteInvite.mockResolvedValue(undefined)
    mocks.writeClipboardText.mockResolvedValue(undefined)
  })

  afterEach(() => {
    cleanup()
    syncStore.reset()
    vi.clearAllMocks()
  })

  it('revokes an invite through a confirmation dialog', async () => {
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false)

    renderWithQuery(<ServerSettingsInvitesPanel serverId="server-1" />)

    expect(await screen.findByText('invite-code')).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: 'Отозвать' }))
    expect(confirmSpy).not.toHaveBeenCalled()
    expect(screen.getByRole('dialog').textContent).toContain('invite-code')
    fireEvent.change(screen.getByLabelText('Причина отзыва'), {
      target: { value: 'rotated link' },
    })
    fireEvent.click(
      screen.getByRole('button', { name: 'Отозвать приглашение' }),
    )

    await waitFor(() => {
      expect(mocks.deleteInvite).toHaveBeenCalledWith(
        'session-token',
        'invite-code',
        { reason: 'rotated link' },
      )
    })
  })

  it('keeps an invite when the revoke dialog is cancelled', async () => {
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false)

    renderWithQuery(<ServerSettingsInvitesPanel serverId="server-1" />)

    expect(await screen.findByText('invite-code')).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: 'Отозвать' }))
    fireEvent.click(screen.getByRole('button', { name: 'Отмена' }))

    expect(mocks.deleteInvite).not.toHaveBeenCalled()
    expect(confirmSpy).not.toHaveBeenCalled()
  })

  it('opens the shared invite dialog from a compact settings button', async () => {
    mocks.fetchServerInvites.mockResolvedValue([])

    renderWithQuery(<ServerSettingsInvitesPanel serverId="server-1" />)

    await screen.findByText('Приглашений пока нет')
    expect(screen.queryByText('Найти друзей')).toBeNull()
    expect(
      screen.queryByText('Или отправьте другу ссылку-приглашение на сервер'),
    ).toBeNull()

    fireEvent.click(
      screen.getByRole('button', { name: 'Создать приглашение' }),
    )

    expect(screen.getByRole('dialog').textContent).toContain(
      'invite dialog for server-1',
    )
    expect(mocks.serverInviteDialog).toHaveBeenLastCalledWith(
      expect.objectContaining({
        serverId: 'server-1',
        open: true,
      }),
    )
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

  it('shows invite creator and creation date without temporary membership UI', async () => {
    syncStore.upsertUser({
      _id: 'user-1',
      username: 'alice',
      display_name: 'Alice',
      avatar: null,
    } as never)
    mocks.fetchServerInvites.mockResolvedValue([
      {
        type: 'Server',
        _id: 'temporary-code',
        server: 'server-1',
        channel: 'channel-1',
        creator: 'user-1',
        created_at: Date.UTC(2026, 5, 19, 12, 30),
        expires_at: null,
        max_uses: null,
        uses: 0,
        revoked_at: null,
        revoked_by: null,
        temporary: true,
      },
    ])

    renderWithQuery(<ServerSettingsInvitesPanel serverId="server-1" />)

    expect(await screen.findByText('temporary-code')).toBeTruthy()
    expect(screen.queryByText('Временное')).toBeNull()
    expect(screen.getByText(/Создал: Alice/)).toBeTruthy()
    expect(screen.getByText(/Создано: .*2026/)).toBeTruthy()
  })

  it('shows who revoked an invite and when it was revoked', async () => {
    syncStore.upsertUsers([
      {
        _id: 'user-1',
        username: 'alice',
        display_name: 'Alice',
        avatar: null,
      } as never,
      {
        _id: 'user-2',
        username: 'bob',
        display_name: 'Bob',
        avatar: null,
      } as never,
    ])
    mocks.fetchServerInvites.mockResolvedValue([
      {
        type: 'Server',
        _id: 'revoked-code',
        server: 'server-1',
        channel: 'channel-1',
        creator: 'user-1',
        created_at: Date.UTC(2026, 5, 18, 10, 0),
        expires_at: null,
        max_uses: null,
        uses: 1,
        revoked_at: Date.UTC(2026, 5, 19, 14, 45),
        revoked_by: 'user-2',
        temporary: false,
      },
    ])

    renderWithQuery(<ServerSettingsInvitesPanel serverId="server-1" />)

    expect(await screen.findByText('revoked-code')).toBeTruthy()
    expect(screen.getByText('Отозвано')).toBeTruthy()
    expect(screen.getByText(/Отозвал: Bob/)).toBeTruthy()
    expect(screen.getByText(/Отозвано: .*2026/)).toBeTruthy()
  })

  it('marks expired and exhausted invites as inactive', async () => {
    const now = Date.now()
    mocks.fetchServerInvites.mockResolvedValue([
      {
        type: 'Server',
        _id: 'expired-code',
        server: 'server-1',
        channel: 'channel-1',
        creator: 'user-1',
        created_at: now - 86_400_000,
        expires_at: now - 1_000,
        max_uses: null,
        uses: 0,
        revoked_at: null,
        revoked_by: null,
        temporary: false,
      },
      {
        type: 'Server',
        _id: 'exhausted-code',
        server: 'server-1',
        channel: 'channel-1',
        creator: 'user-1',
        created_at: now - 86_400_000,
        expires_at: now + 86_400_000,
        max_uses: 5,
        uses: 5,
        revoked_at: null,
        revoked_by: null,
        temporary: false,
      },
    ])

    renderWithQuery(<ServerSettingsInvitesPanel serverId="server-1" />)

    expect(await screen.findByText('expired-code')).toBeTruthy()
    expect(await screen.findByText('exhausted-code')).toBeTruthy()
    expect(screen.getByText('Истекло')).toBeTruthy()
    expect(screen.getByText('Использовано')).toBeTruthy()
    expect(
      (
        screen.getByRole('button', {
          name: 'Копировать expired-code',
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true)
    expect(
      (
        screen.getByRole('button', {
          name: 'Копировать exhausted-code',
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true)
  })
})
