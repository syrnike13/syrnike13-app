import { beforeEach, describe, expect, it, vi } from 'vitest'
import { Effect } from 'effect'

import { fetchServerMembersEffect } from '@syrnike13/client/api/servers-api'
import { listServerMembers } from '@syrnike13/client/sync/selectors'
import {
  clearServerMembersSyncCache,
  loadServerMembersIntoSyncStore,
} from '#/features/sync/server-members-sync'
import { syncStore } from '@syrnike13/client/sync/sync-store'

vi.mock('@syrnike13/client/api/servers-api', () => ({
  fetchServerMembersEffect: vi.fn(),
}))

const SERVER_ID = '01KT7DEM3B0T4B0BXGBXWDJ700'
const USER_ID = '01KT7DEM3B0T4B0BXGBXWDJ701'

describe('loadServerMembersIntoSyncStore', () => {
  beforeEach(() => {
    syncStore.reset()
    clearServerMembersSyncCache()
    vi.mocked(fetchServerMembersEffect).mockReset()
  })

  it('loads server members and users into the sync store', async () => {
    vi.mocked(fetchServerMembersEffect).mockReturnValue(
      Effect.succeed({
        members: [
          {
            _id: {
              server: SERVER_ID,
              user: USER_ID,
            },
          },
        ],
        users: [
          {
            _id: USER_ID,
            username: 'alice',
            online: true,
          },
        ],
      } as never),
    )

    await loadServerMembersIntoSyncStore('token-1', SERVER_ID)

    expect(fetchServerMembersEffect).toHaveBeenCalledWith(
      'token-1',
      SERVER_ID,
    )
    expect(listServerMembers(syncStore.getState(), SERVER_ID)).toEqual([
      expect.objectContaining({
        member: expect.objectContaining({
          _id: { server: SERVER_ID, user: USER_ID },
        }),
        user: expect.objectContaining({ _id: USER_ID, username: 'alice' }),
      }),
    ])
  })
})
