import { beforeEach, describe, expect, it } from 'vitest'

import {
  canAccessAdmin,
  canManageChannel,
  canManageServerChannels,
  ChannelPermission,
} from './authorization'
import { syncStore } from '#/features/sync/sync-store'

const server = { _id: 'server', owner: 'owner' } as never
const channel = {
  _id: 'channel',
  channel_type: 'TextChannel',
  server: 'server',
} as never

describe('backend authorization snapshot', () => {
  beforeEach(() => syncStore.reset())

  it('fails closed when a scope is absent', () => {
    expect(canAccessAdmin()).toBe(false)
    expect(canManageServerChannels(server, undefined, 'owner')).toBe(false)
    expect(canManageChannel(server, channel, undefined, 'owner')).toBe(false)
  })

  it('takes global capabilities only from the snapshot', () => {
    syncStore.handleGatewayEvent({
      type: 'AuthorizationSnapshot',
      snapshot: {
        revision: 1,
        global: 1,
        servers: {},
        channels: {},
        users: {},
      },
    })

    expect(canAccessAdmin()).toBe(true)
  })

  it('uses channel-specific effective permissions for channel controls', () => {
    syncStore.handleGatewayEvent({
      type: 'Ready',
      authorization: {
        revision: 1,
        global: 0,
        servers: { server: ChannelPermission.ManageChannel },
        channels: { channel: 0 },
        users: {},
      },
    })

    expect(canManageServerChannels(server, undefined, 'user')).toBe(true)
    expect(canManageChannel(server, channel, undefined, 'user')).toBe(false)

    syncStore.handleGatewayEvent({
      type: 'AuthorizationSnapshot',
      snapshot: {
        revision: 2,
        global: 0,
        servers: { server: 0 },
        channels: { channel: ChannelPermission.ManageChannel },
        users: {},
      },
    })

    expect(canManageServerChannels(server, undefined, 'user')).toBe(false)
    expect(canManageChannel(server, channel, undefined, 'user')).toBe(true)
  })
})
