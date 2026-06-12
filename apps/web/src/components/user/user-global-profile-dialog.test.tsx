// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { UserGlobalProfileDialog } from '#/components/user/user-global-profile-dialog'
import { syncStore } from '#/features/sync/sync-store'

const mocks = vi.hoisted(() => ({
  navigate: vi.fn(),
  openSettings: vi.fn(),
  voiceJoin: vi.fn().mockResolvedValue(true),
  openDirectMessageChannel: vi.fn(
    async (
      _token: string,
      _userId: string,
      navigateToChannel: (channelId: string) => Promise<void> | void,
    ) => {
      await navigateToChannel('dm-1')
      return {
        _id: 'dm-1',
        channel_type: 'DirectMessage',
        active: true,
        recipients: ['user-current', 'user-target'],
      }
    },
  ),
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

vi.mock('#/features/voice/voice-context', () => ({
  useVoice: () => ({
    join: mocks.voiceJoin,
  }),
}))

vi.mock('#/features/dm/dm-actions', () => ({
  openDirectMessageChannel: mocks.openDirectMessageChannel,
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
  UserGlobalProfileSidebar: ({
    onStartCall,
  }: {
    onStartCall?: () => void
  }) => (
    <aside>
      {onStartCall ? (
        <button type="button" onClick={onStartCall}>
          Позвонить
        </button>
      ) : null}
    </aside>
  ),
}))

describe('UserGlobalProfileDialog', () => {
  beforeEach(() => {
    mocks.navigate.mockClear()
    mocks.openSettings.mockClear()
    mocks.voiceJoin.mockClear()
    mocks.openDirectMessageChannel.mockClear()
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

  it('starts a direct message call from the profile actions', async () => {
    render(
      <UserGlobalProfileDialog
        user={{ _id: 'user-target', username: 'bob', online: true } as never}
        open
        onOpenChange={vi.fn()}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: 'Позвонить' }))

    expect(mocks.openDirectMessageChannel).toHaveBeenCalledWith(
      'session-token',
      'user-target',
      expect.any(Function),
    )
    expect(mocks.navigate).toHaveBeenCalledWith({
      to: '/app/c/$channelId',
      params: { channelId: 'dm-1' },
      search: { m: undefined },
    })
    await waitFor(() => {
      expect(mocks.voiceJoin).toHaveBeenCalledWith('dm-1')
    })
  })
})
