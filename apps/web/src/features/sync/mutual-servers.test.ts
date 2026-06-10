import { describe, expect, it } from 'vitest'

import { listMutualServers } from '#/features/sync/selectors'
import type { SyncState } from '#/features/sync/types'

function makeState(
  overrides: Partial<SyncState> = {},
): SyncState {
  return {
    servers: {},
    channels: {},
    members: {},
    users: {},
    messages: {},
    voiceParticipants: {},
    ...overrides,
  } as SyncState
}

describe('listMutualServers', () => {
  it('returns servers where both users are members', () => {
    const state = makeState({
      servers: {
        'server-a': { _id: 'server-a', name: 'Alpha' } as SyncState['servers'][string],
        'server-b': { _id: 'server-b', name: 'Beta' } as SyncState['servers'][string],
        'server-c': { _id: 'server-c', name: 'Gamma' } as SyncState['servers'][string],
      },
      members: {
        'server-a:user-1': { _id: { server: 'server-a', user: 'user-1' } } as SyncState['members'][string],
        'server-a:user-2': { _id: { server: 'server-a', user: 'user-2' } } as SyncState['members'][string],
        'server-b:user-1': { _id: { server: 'server-b', user: 'user-1' } } as SyncState['members'][string],
        'server-c:user-2': { _id: { server: 'server-c', user: 'user-2' } } as SyncState['members'][string],
      },
    })

    expect(listMutualServers(state, 'user-2', 'user-1').map((s) => s._id)).toEqual([
      'server-a',
    ])
  })

  it('returns empty for self profile', () => {
    const state = makeState({
      servers: {
        'server-a': { _id: 'server-a', name: 'Alpha' } as SyncState['servers'][string],
      },
      members: {
        'server-a:user-1': { _id: { server: 'server-a', user: 'user-1' } } as SyncState['members'][string],
      },
    })

    expect(listMutualServers(state, 'user-1', 'user-1')).toEqual([])
  })
})
