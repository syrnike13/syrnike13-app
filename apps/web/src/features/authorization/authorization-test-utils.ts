import { syncStore } from '#/features/sync/sync-store'

const ALL_PERMISSIONS = 0x000f_ffff_ffff_ffff

export function installAuthorizationForTest({
  global = 0,
  servers = {},
  channels = {},
  users = {},
}: {
  global?: number
  servers?: Record<string, number>
  channels?: Record<string, number>
  users?: Record<string, number>
}) {
  syncStore.handleGatewayEvent({
    type: 'AuthorizationSnapshot',
    snapshot: {
      revision: syncStore.getState().authorization.revision + 1,
      global,
      servers,
      channels,
      users,
    },
  })
}

export function grantAllAuthorizationForTest({
  serverIds = [],
  channelIds = [],
  userIds = [],
}: {
  serverIds?: string[]
  channelIds?: string[]
  userIds?: string[]
}) {
  installAuthorizationForTest({
    servers: Object.fromEntries(serverIds.map((id) => [id, ALL_PERMISSIONS])),
    channels: Object.fromEntries(channelIds.map((id) => [id, ALL_PERMISSIONS])),
    users: Object.fromEntries(userIds.map((id) => [id, ALL_PERMISSIONS])),
  })
}
