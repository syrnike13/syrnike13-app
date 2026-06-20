// @vitest-environment jsdom

import type { Channel } from '@syrnike13/api-types'
import { cleanup, render, screen } from '@testing-library/react'
import type { ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { ChannelSettingsPage } from '#/components/channels/channel-settings-page'
import { syncStore } from '#/features/sync/sync-store'
import { ChannelPermission } from '#/lib/permissions'

const mocks = vi.hoisted(() => ({
  navigate: vi.fn(),
}))

vi.mock('@tanstack/react-router', () => ({
  Link: ({
    children,
    params,
  }: {
    children: ReactNode
    params: { channelId: string }
  }) => <a href={`/app/c/${params.channelId}`}>{children}</a>,
  useNavigate: () => mocks.navigate,
}))

vi.mock('#/features/auth/auth-context', () => ({
  useAuth: () => ({
    session: { token: 'session-token' },
    user: { _id: 'user-1', username: 'alice' },
  }),
}))

vi.mock('#/features/navigation/route-prefix', () => ({
  useAppRoutePrefix: () => '/app',
}))

vi.mock('#/components/channels/channel-settings-permissions-panel', () => ({
  ChannelSettingsPermissionsPanel: ({
    channel,
  }: {
    channel: { _id: string }
  }) => <div data-testid="permissions-panel">{channel._id}</div>,
}))

const legacyVoiceChannel = {
  _id: 'voice-legacy',
  channel_type: 'VoiceChannel',
  server: 'server-1',
  name: 'Voice Legacy',
  default_permissions: null,
  role_permissions: {},
  voice: { max_users: null },
} as unknown as Channel

describe('ChannelSettingsPage', () => {
  beforeEach(() => {
    syncStore.reset()
    syncStore.upsertServer({
      _id: 'server-1',
      name: 'Server',
      owner: 'owner-user',
      channels: ['voice-legacy'],
      default_permissions:
        ChannelPermission.ViewChannel | ChannelPermission.ManagePermissions,
    } as never)
    syncStore.upsertMembers([
      {
        _id: { server: 'server-1', user: 'user-1' },
        joined_at: '2024-01-01T00:00:00Z',
        roles: [],
      } as never,
    ])
    syncStore.upsertChannel(legacyVoiceChannel)
    mocks.navigate.mockResolvedValue(undefined)
    mocks.navigate.mockClear()
  })

  afterEach(() => {
    cleanup()
    syncStore.reset()
    vi.restoreAllMocks()
    vi.clearAllMocks()
  })

  it('opens the permissions tab for manageable legacy voice channels', () => {
    render(
      <ChannelSettingsPage
        channelId="voice-legacy"
        hostChannelId="voice-legacy"
        tab="permissions"
      />,
    )

    expect(screen.getByTestId('permissions-panel').textContent).toBe(
      'voice-legacy',
    )
  })
})
