// @vitest-environment jsdom

import type { Channel } from '@syrnike13/api-types'
import { cleanup, render, screen } from '@testing-library/react'
import type { ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { ChannelSettingsPage } from '#/components/channels/channel-settings-page'
import { syncStore } from '#/features/sync/sync-store'
import { ChannelPermission } from '#/features/authorization/authorization'
import {
  grantAllAuthorizationForTest,
  installAuthorizationForTest,
} from '#/features/authorization/authorization-test-utils'

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

vi.mock('#/components/channels/channel-settings-webhooks-panel', () => ({
  ChannelSettingsWebhooksPanel: ({
    channel,
  }: {
    channel: { _id: string }
  }) => <div data-testid="webhooks-panel">{channel._id}</div>,
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

const textChannel = {
  _id: 'text-general',
  channel_type: 'TextChannel',
  server: 'server-1',
  name: 'general',
  description: null,
  nsfw: false,
  slowmode: 0,
  default_permissions: null,
  role_permissions: {},
} satisfies Extract<Channel, { channel_type: 'TextChannel' }>

describe('ChannelSettingsPage', () => {
  beforeEach(() => {
    syncStore.reset()
    grantAllAuthorizationForTest({
      serverIds: ['server-1'],
      channelIds: ['voice-legacy', 'text-general'],
    })
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

  it('opens the webhooks tab for webhook-only text channel admins', () => {
    syncStore.reset()
    installAuthorizationForTest({
      channels: { 'text-general': ChannelPermission.ManageWebhooks },
    })
    syncStore.upsertServer({
      _id: 'server-1',
      name: 'Server',
      owner: 'owner-user',
      channels: ['text-general'],
      default_permissions:
        ChannelPermission.ViewChannel | ChannelPermission.ManageWebhooks,
    } as never)
    syncStore.upsertMembers([
      {
        _id: { server: 'server-1', user: 'user-1' },
        joined_at: '2024-01-01T00:00:00Z',
        roles: [],
      } as never,
    ])
    syncStore.upsertChannel(textChannel)

    render(
      <ChannelSettingsPage
        channelId="text-general"
        hostChannelId="text-general"
        tab="permissions"
      />,
    )

    expect(screen.getByTestId('webhooks-panel').textContent).toBe(
      'text-general',
    )
    expect(screen.queryByTestId('permissions-panel')).toBeNull()
    expect(mocks.navigate).not.toHaveBeenCalled()
  })
})
