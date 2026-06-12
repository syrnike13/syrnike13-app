// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { UserGlobalProfileDialog } from '#/components/user/user-global-profile-dialog'
import { syncStore } from '#/features/sync/sync-store'

const mocks = vi.hoisted(() => ({
  navigate: vi.fn(),
  openSettings: vi.fn(),
}))

vi.mock('@tanstack/react-router', () => ({
  useNavigate: () => mocks.navigate,
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

vi.mock('#/components/ui/dialog', () => ({
  Dialog: ({ open, children }: { open: boolean; children: ReactNode }) =>
    open ? <div>{children}</div> : null,
  DialogContent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DialogDescription: ({ children }: { children: ReactNode }) => (
    <p>{children}</p>
  ),
  DialogTitle: ({ children }: { children: ReactNode }) => <h2>{children}</h2>,
}))

vi.mock('#/components/user/user-global-profile-sidebar', () => ({
  UserGlobalProfileSidebar: () => <aside data-testid="profile-sidebar" />,
}))

describe('UserGlobalProfileDialog', () => {
  beforeEach(() => {
    mocks.navigate.mockClear()
    mocks.openSettings.mockClear()
    syncStore.reset()
    syncStore.upsertServer({
      _id: 'server-a',
      name: 'Alpha',
      owner: 'owner',
      channels: ['channel-a'],
      default_permissions: 0,
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
})
