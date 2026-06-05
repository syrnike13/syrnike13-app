import { describe, expect, it } from 'vitest'

import {
  getPermissionTriState,
  overrideFieldToApi,
  roleRanksPayload,
  setPermissionTriState,
  ServerPermission,
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
})

describe('roleRanksPayload', () => {
  it('reverses highest-first ids into lowest-first ranks', () => {
    expect(roleRanksPayload(['admin', 'mod', 'default'])).toEqual([
      'default',
      'mod',
      'admin',
    ])
  })
})
