import * as ApiSchema from '@syrnike13/api-types/effect-schema'
import { Effect, Schema } from 'effect'
import { describe, expect, it, vi } from 'vitest'

import {
  deleteOrLeaveServer,
  fetchServerAuditLog,
} from '#/features/api/servers-api'

const mocks = vi.hoisted(() => ({
  apiRequestEffect: vi.fn(),
}))

vi.mock('#/lib/api/client', () => ({
  apiRequestEffect: (...args: Parameters<typeof mocks.apiRequestEffect>) =>
    mocks.apiRequestEffect(...args),
}))

describe('fetchServerAuditLog', () => {
  it('encodes audit filters as query parameters', async () => {
    mocks.apiRequestEffect.mockReturnValue(
      Effect.succeed({ entries: [], next_before: null }),
    )

    await fetchServerAuditLog('session-token', 'server-1', {
      before: 'audit-1',
      actor: 'actor-1',
      action: 'MemberBan',
      target_type: 'User',
      target_id: 'user-2',
      limit: 25,
    })

    expect(mocks.apiRequestEffect).toHaveBeenCalledWith(
      '/servers/server-1/audit-log?before=audit-1&actor=actor-1&action=MemberBan&target_type=User&target_id=user-2&limit=25',
      ApiSchema.AuditLogFetchAuditLog200,
      { token: 'session-token' },
    )
  })
})

describe('deleteOrLeaveServer', () => {
  it('deletes or leaves servers with leave_silently encoded as a query option', async () => {
    mocks.apiRequestEffect.mockReturnValue(Effect.void)

    await deleteOrLeaveServer('session-token', 'server-1')

    expect(mocks.apiRequestEffect).toHaveBeenCalledWith(
      '/servers/server-1?leave_silently=false',
      Schema.Void,
      {
        method: 'DELETE',
        token: 'session-token',
      },
    )
  })
})
