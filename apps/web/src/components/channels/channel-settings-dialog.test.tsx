// @vitest-environment jsdom

import type { Channel } from '@syrnike13/api-types'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { ChannelSettingsDialog } from '#/components/channels/channel-settings-dialog'
import { syncStore } from '#/features/sync/sync-store'
import { ChannelPermission } from '#/lib/permissions'

const mocks = vi.hoisted(() => ({
  navigate: vi.fn(),
}))

vi.mock('@tanstack/react-router', () => ({
  useNavigate: () => mocks.navigate,
  useMatch: () => ({
    params: { channelId: 'text-general' },
    search: { m: undefined },
  }),
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

describe('ChannelSettingsDialog', () => {
  beforeEach(() => {
    syncStore.reset()
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
    mocks.navigate.mockResolvedValue(undefined)
    mocks.navigate.mockClear()
  })

  afterEach(() => {
    cleanup()
    syncStore.reset()
    vi.restoreAllMocks()
    vi.clearAllMocks()
  })

  it('opens channel settings for webhook-only admins on the webhooks tab', () => {
    render(<ChannelSettingsDialog channel={textChannel} />)

    fireEvent.click(screen.getByRole('button'))

    expect(mocks.navigate).toHaveBeenCalledWith({
      to: '/app/c/$channelId',
      params: { channelId: 'text-general' },
      search: {
        settingsChannel: 'text-general',
        settingsTab: 'webhooks',
        m: undefined,
      },
    })
  })
})
