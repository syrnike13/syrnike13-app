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

import { UserGlobalProfileDialog } from '#/components/user/user-global-profile-dialog'
import { syncStore } from '#/features/sync/sync-store'
import { ChannelPermission } from '#/lib/permissions'

const mocks = vi.hoisted(() => ({
  navigate: vi.fn(),
  openSettings: vi.fn(),
  blockUserRelationship: vi.fn(),
}))

vi.mock('@tanstack/react-router', () => ({
  useNavigate: () => mocks.navigate,
  useRouterState: ({ select }: { select: (state: { location: { pathname: string } }) => unknown }) =>
    select({ location: { pathname: '/app/' } }),
}))

vi.mock('#/features/auth/auth-context', () => ({
  useAuth: () => ({
    session: { token: 'session-token' },
    user: { _id: 'user-current', username: 'alice' },
  }),
}))

vi.mock('#/features/settings/settings-modal-context', () => ({
  useSettingsModal: () => ({
    openSettings: mocks.openSettings,
  }),
}))

vi.mock('#/features/dm/dm-actions', () => ({
  openDirectMessageChannel: vi.fn(),
}))

vi.mock('#/features/friends/friend-actions', () => ({
  blockUserRelationship: (
    ...args: Parameters<typeof mocks.blockUserRelationship>
  ) => mocks.blockUserRelationship(...args),
}))

vi.mock('#/components/ui/dialog', () => ({
  Dialog: ({ open, children }: { open: boolean; children: ReactNode }) =>
    open ? <div>{children}</div> : null,
  DialogContent: ({ children }: { children: ReactNode }) => (
    <div role="dialog">{children}</div>
  ),
  DialogDescription: ({ children }: { children: ReactNode }) => (
    <p>{children}</p>
  ),
  DialogFooter: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DialogHeader: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DialogTitle: ({ children }: { children: ReactNode }) => <h2>{children}</h2>,
}))

vi.mock('#/components/user/user-global-profile-sidebar', () => ({
  UserGlobalProfileSidebar: ({
    onBlock,
  }: {
    onBlock?: () => void
  }) => (
    <aside data-testid="profile-sidebar">
      <button type="button" onClick={onBlock}>
        Заблокировать
      </button>
    </aside>
  ),
}))

describe('UserGlobalProfileDialog', () => {
  beforeEach(() => {
    mocks.navigate.mockClear()
    mocks.openSettings.mockClear()
    mocks.blockUserRelationship.mockResolvedValue(undefined)
    mocks.blockUserRelationship.mockClear()
    syncStore.reset()
    syncStore.upsertServer({
      _id: 'server-a',
      name: 'Alpha',
      owner: 'owner',
      channels: ['channel-a'],
      default_permissions: ChannelPermission.ViewChannel,
    } as never)
    syncStore.upsertChannel({
      _id: 'channel-a',
      channel_type: 'TextChannel',
      server: 'server-a',
      name: 'general',
    } as never)
    syncStore.upsertMembers([
      { _id: { server: 'server-a', user: 'user-current' } },
      { _id: { server: 'server-a', user: 'user-target' } },
    ] as never)
  })

  afterEach(() => {
    cleanup()
    syncStore.reset()
    vi.restoreAllMocks()
  })

  it('clears message search when opening a mutual server channel', () => {
    render(
      <UserGlobalProfileDialog
        user={{ _id: 'user-target', username: 'bob', online: true } as never}
        open
        onOpenChange={vi.fn()}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: /Alpha/ }))

    expect(mocks.navigate).toHaveBeenCalledWith({
      to: '/app/c/$channelId',
      params: { channelId: 'channel-a' },
      search: { m: undefined },
    })
  })

  it('opens a block confirmation dialog before blocking from the global profile', async () => {
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false)

    render(
      <UserGlobalProfileDialog
        user={{ _id: 'user-target', username: 'bob', online: true } as never}
        open
        onOpenChange={vi.fn()}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: 'Заблокировать' }))

    expect(confirmSpy).not.toHaveBeenCalled()
    expect(mocks.blockUserRelationship).not.toHaveBeenCalled()

    const dialog = screen.getAllByRole('dialog').at(-1)!
    expect(dialog.textContent).toContain('@bob')

    fireEvent.click(
      within(dialog).getByRole('button', { name: 'Заблокировать' }),
    )

    await waitFor(() => {
      expect(mocks.blockUserRelationship).toHaveBeenCalledWith(
        'session-token',
        'user-target',
      )
    })
  })
})
