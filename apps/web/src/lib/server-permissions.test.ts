import { describe, expect, it } from 'vitest'

import {
  getAllowedPermissionTriStates,
  getPermissionTriState,
  overrideFieldToApi,
  roleRanksPayload,
  setPermissionTriState,
  ServerPermission,
  sortRolesByHierarchy,
} from '#/lib/server-permissions'

describe('server permission overrides', () => {
  it('handles permission bits above 31', () => {
    const initial = { a: 0, d: 0 }
    const allowed = setPermissionTriState(
      initial,
      ServerPermission.Video,
      'allow',
    )
    expect(getPermissionTriState(allowed, ServerPermission.Video)).toBe('allow')
    expect(overrideFieldToApi(allowed).allow).toBe(ServerPermission.Video)
  })

  it('cycles allow and deny bits', () => {
    const initial = { a: 0, d: 0 }
    const allowed = setPermissionTriState(
      initial,
      ServerPermission.SendMessage,
      'allow',
    )
    expect(getPermissionTriState(allowed, ServerPermission.SendMessage)).toBe(
      'allow',
    )

    const denied = setPermissionTriState(
      allowed,
      ServerPermission.SendMessage,
      'deny',
    )
    expect(getPermissionTriState(denied, ServerPermission.SendMessage)).toBe(
      'deny',
    )
    expect(overrideFieldToApi(denied)).toEqual({
      allow: 0,
      deny: ServerPermission.SendMessage,
    })
  })

  it('does not allow granting a missing permission from neutral', () => {
    expect(getAllowedPermissionTriStates({ a: 0, d: 0 }, 0, 1)).toEqual([
      'neutral',
      'deny',
    ])
  })

  it('does not allow removing a deny for a missing permission', () => {
    expect(getAllowedPermissionTriStates({ a: 0, d: 1 }, 0, 1)).toEqual([
      'deny',
    ])
  })

  it('allows removing an existing allow even when the actor lacks it', () => {
    expect(getAllowedPermissionTriStates({ a: 1, d: 0 }, 0, 1)).toEqual([
      'neutral',
      'allow',
      'deny',
    ])
  })

  it('allows all states when the actor has the permission', () => {
    expect(getAllowedPermissionTriStates({ a: 0, d: 1 }, 1, 1)).toEqual([
      'neutral',
      'allow',
      'deny',
    ])
  })
})

describe('roleRanksPayload', () => {
  it('keeps the visible role list highest first', () => {
    expect(
      sortRolesByHierarchy([
        { _id: 'bottom-role', rank: 5 },
        { _id: 'top-role', rank: 1 },
        { _id: 'middle-role', rank: 3 },
      ]).map((role) => role._id),
    ).toEqual(['top-role', 'middle-role', 'bottom-role'])
  })

  it('keeps highest-first ids because the backend assigns ranks by array index', () => {
    expect(roleRanksPayload(['top-role', 'middle-role', 'bottom-role'])).toEqual([
      'top-role',
      'middle-role',
      'bottom-role',
    ])
  })
})
