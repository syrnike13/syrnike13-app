import { beforeEach, describe, expect, it, vi } from 'vitest'

import { fetchServerMembers } from '#/features/api/servers-api'
import { listServerMembers } from '#/features/sync/selectors'
import {
  clearServerMembersSyncCache,
  loadServerMembersIntoSyncStore,
} from '#/features/sync/server-members-sync'
import { syncStore } from '#/features/sync/sync-store'

vi.mock('#/features/api/servers-api', () => ({
  fetchServerMembers: vi.fn(),
}))

const SERVER_ID = '01KT7DEM3B0T4B0BXGBXWDJ700'
const USER_ID = '01KT7DEM3B0T4B0BXGBXWDJ701'

describe('loadServerMembersIntoSyncStore', () => {
  beforeEach(() => {
    syncStore.reset()
    clearServerMembersSyncCache()
    vi.mocked(fetchServerMembers).mockReset()
  })

  it('loads server members and users into the sync store', async () => {
    vi.mocked(fetchServerMembers).mockResolvedValue({
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
    } as never)

    await loadServerMembersIntoSyncStore('token-1', SERVER_ID)

    expect(fetchServerMembers).toHaveBeenCalledWith('token-1', SERVER_ID)
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
