// @vitest-environment jsdom

import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react'
import type { ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { ServerHeaderMenu } from '#/components/servers/server-header-menu'
import { syncStore } from '#/features/sync/sync-store'

const mocks = vi.hoisted(() => ({
  deleteOrLeaveServer: vi.fn(),
  navigate: vi.fn(),
}))

vi.mock('@tanstack/react-router', () => ({
  useNavigate: () => mocks.navigate,
}))

vi.mock('sonner', () => ({
  toast: {
    error: vi.fn(),
    success: vi.fn(),
  },
}))

vi.mock('#/components/channels/create-category-dialog', () => ({
  CreateCategoryDialog: () => null,
}))

vi.mock('#/components/servers/create-channel-dialog', () => ({
  CreateChannelDialog: () => null,
}))

vi.mock('#/components/servers/server-invite-dialog', () => ({
  ServerInviteDialog: () => null,
}))

vi.mock('#/components/ui/dialog', () => ({
  Dialog: ({
    children,
    open,
  }: {
    children: ReactNode
    open?: boolean
  }) => (open ? <>{children}</> : null),
  DialogContent: ({ children }: { children: ReactNode }) => (
    <div role="dialog">{children}</div>
  ),
  DialogDescription: ({ children }: { children: ReactNode }) => (
    <p>{children}</p>
  ),
  DialogFooter: ({ children }: { children: ReactNode }) => (
    <div>{children}</div>
  ),
  DialogHeader: ({ children }: { children: ReactNode }) => (
    <div>{children}</div>
  ),
  DialogTitle: ({ children }: { children: ReactNode }) => <h2>{children}</h2>,
}))

vi.mock('#/features/auth/auth-context', () => ({
  useAuth: () => ({
    session: { token: 'session-token' },
    user: { _id: 'user-1', username: 'alice' },
  }),
}))

vi.mock('#/features/api/servers-api', () => ({
  deleteOrLeaveServer: (
    ...args: Parameters<typeof mocks.deleteOrLeaveServer>
  ) => mocks.deleteOrLeaveServer(...args),
}))

vi.mock('#/features/navigation/route-prefix', () => ({
  useAppRoutePrefix: () => '/app',
}))

function upsertServer(owner = 'user-1') {
  syncStore.upsertServer({
    _id: 'server-1',
    name: 'Server',
    owner,
    channels: [],
    default_permissions: 0,
  } as never)
  syncStore.upsertMembers([
    {
      _id: { server: 'server-1', user: 'user-1' },
      joined_at: '2024-01-01T00:00:00Z',
    } as never,
  ])
}

describe('ServerHeaderMenu', () => {
  beforeEach(() => {
    syncStore.reset()
    upsertServer()
    mocks.deleteOrLeaveServer.mockResolvedValue(undefined)
    mocks.navigate.mockResolvedValue(undefined)
  })

  afterEach(() => {
    cleanup()
    syncStore.reset()
    vi.restoreAllMocks()
    vi.clearAllMocks()
  })

  it('labels the owner destructive action as deleting the server', () => {
    render(<ServerHeaderMenu serverId="server-1" serverName="Server" />)

    fireEvent.click(screen.getByRole('button', { name: 'Server' }))

    expect(
      screen.getByRole('button', { name: 'Удалить сервер' }),
    ).toBeTruthy()
    expect(
      screen.queryByRole('button', { name: 'Покинуть сервер' }),
    ).toBeNull()
  })

  it('keeps the leave label for non-owner members', () => {
    syncStore.reset()
    upsertServer('owner-2')

    render(<ServerHeaderMenu serverId="server-1" serverName="Server" />)

    fireEvent.click(screen.getByRole('button', { name: 'Server' }))

    expect(
      screen.getByRole('button', { name: 'Покинуть сервер' }),
    ).toBeTruthy()
    expect(
      screen.queryByRole('button', { name: 'Удалить сервер' }),
    ).toBeNull()
  })

  it('confirms server deletion in a dialog before calling the API', async () => {
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false)

    render(<ServerHeaderMenu serverId="server-1" serverName="Server" />)

    fireEvent.click(screen.getByRole('button', { name: 'Server' }))
    fireEvent.click(
      screen.getByRole('button', { name: 'Удалить сервер' }),
    )

    expect(confirmSpy).not.toHaveBeenCalled()
    expect(mocks.deleteOrLeaveServer).not.toHaveBeenCalled()

    const dialog = screen.getByRole('dialog')
    expect(dialog.textContent).toContain('Server')

    fireEvent.click(
      within(dialog).getByRole('button', {
        name: 'Удалить сервер',
      }),
    )

    await waitFor(() => {
      expect(mocks.deleteOrLeaveServer).toHaveBeenCalledWith(
        'session-token',
        'server-1',
      )
    })
  })

  it('confirms leaving a server in a dialog before calling the API', async () => {
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false)
    syncStore.reset()
    upsertServer('owner-2')

    render(<ServerHeaderMenu serverId="server-1" serverName="Server" />)

    fireEvent.click(screen.getByRole('button', { name: 'Server' }))
    fireEvent.click(
      screen.getByRole('button', { name: 'Покинуть сервер' }),
    )

    expect(confirmSpy).not.toHaveBeenCalled()
    expect(mocks.deleteOrLeaveServer).not.toHaveBeenCalled()

    const dialog = screen.getByRole('dialog')
    expect(dialog.textContent).toContain('Server')

    fireEvent.click(
      within(dialog).getByRole('button', {
        name: 'Покинуть сервер',
      }),
    )

    await waitFor(() => {
      expect(mocks.deleteOrLeaveServer).toHaveBeenCalledWith(
        'session-token',
        'server-1',
      )
    })
  })

  it('opens roles and audit settings directly from the server menu', () => {
    render(<ServerHeaderMenu serverId="server-1" serverName="Server" />)

    fireEvent.click(screen.getByRole('button', { name: 'Server' }))
    fireEvent.click(screen.getByRole('button', { name: 'Роли' }))

    expect(mocks.navigate).toHaveBeenCalledWith({
      to: '/app/servers/$serverId/settings',
      params: { serverId: 'server-1' },
      search: { tab: 'roles' },
    })

    fireEvent.click(screen.getByRole('button', { name: 'Server' }))
    fireEvent.click(screen.getByRole('button', { name: 'Журнал аудита' }))

    expect(mocks.navigate).toHaveBeenCalledWith({
      to: '/app/servers/$serverId/settings',
      params: { serverId: 'server-1' },
      search: { tab: 'audit' },
    })
  })
})
