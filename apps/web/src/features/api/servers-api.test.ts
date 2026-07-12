import { describe, expect, it, vi } from 'vitest'

import {
  deleteOrLeaveServer,
  fetchServerAuditLog,
} from '#/features/api/servers-api'

const mocks = vi.hoisted(() => ({
  apiRequest: vi.fn(),
}))

vi.mock('#/lib/api/client', () => ({
  apiRequest: (...args: Parameters<typeof mocks.apiRequest>) =>
    mocks.apiRequest(...args),
}))

describe('fetchServerAuditLog', () => {
  it('encodes audit filters as query parameters', async () => {
    mocks.apiRequest.mockResolvedValue({ entries: [], next_before: null })

    await fetchServerAuditLog('session-token', 'server-1', {
      before: 'audit-1',
      actor: 'actor-1',
      action: 'MemberBan',
      target_type: 'User',
      target_id: 'user-2',
      limit: 25,
    })

    expect(mocks.apiRequest).toHaveBeenCalledWith(
      '/servers/server-1/audit-log?before=audit-1&actor=actor-1&action=MemberBan&target_type=User&target_id=user-2&limit=25',
      { token: 'session-token' },
    )
  })
})

describe('deleteOrLeaveServer', () => {
  it('deletes or leaves servers with leave_silently encoded as a query option', async () => {
    mocks.apiRequest.mockResolvedValue(undefined)

    await deleteOrLeaveServer('session-token', 'server-1')

    expect(mocks.apiRequest).toHaveBeenCalledWith(
      '/servers/server-1?leave_silently=false',
      {
        method: 'DELETE',
        token: 'session-token',
      },
    )
  })
})
