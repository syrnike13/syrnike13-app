import { beforeEach, describe, expect, it, vi } from 'vitest'
import { Effect } from 'effect'

import {
  createAdminActivityEffect,
  deleteAdminActivityEffect,
  fetchAdminActivities,
  rotateAdminActivitySecret,
  updateAdminActivity,
} from '#/features/api/activities-api'

const mocks = vi.hoisted(() => ({ apiRequestEffect: vi.fn() }))

vi.mock('#/lib/api/client', () => ({
  apiRequestEffect: (...args: Parameters<typeof mocks.apiRequestEffect>) =>
    mocks.apiRequestEffect(...args),
}))

describe('activities admin api', () => {
  beforeEach(() => {
    mocks.apiRequestEffect.mockReset()
    mocks.apiRequestEffect.mockReturnValue(Effect.void)
  })

  it('uses the admin activities endpoints with the session token', async () => {
    await fetchAdminActivities('token')
    await Effect.runPromise(
      createAdminActivityEffect('token', {
        id: 'chess',
        name: 'Chess',
        origin_url: 'https://chess.example.com',
        url_mappings: [],
        max_participants: 2,
        first_party: false,
        enabled: true,
      }),
    )
    await updateAdminActivity('token', 'chess', { enabled: false })
    await Effect.runPromise(deleteAdminActivityEffect('token', 'chess'))
    await rotateAdminActivitySecret('token', 'chess')

    const calls = mocks.apiRequestEffect.mock.calls.map(([path, , options]) => [
      path,
      options,
    ])
    expect(calls).toEqual([
      ['/admin/activities', { token: 'token' }],
      [
        '/admin/activities',
        expect.objectContaining({ method: 'POST', token: 'token' }),
      ],
      [
        '/admin/activities/chess',
        { method: 'PATCH', token: 'token', body: { enabled: false } },
      ],
      ['/admin/activities/chess', { method: 'DELETE', token: 'token' }],
      ['/admin/activities/chess/secret', { method: 'POST', token: 'token' }],
    ])
  })
})
