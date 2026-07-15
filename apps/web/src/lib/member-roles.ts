import type { Member, Role, Server } from '@syrnike13/api-types'

import {
  canAccessAdmin,
  canAssignRole,
} from '#/features/authorization/authorization'
import { sortRolesByHierarchy } from '#/lib/server-permissions'

export function listServerRoles(server: Server | undefined): Role[] {
  if (!server?.roles) return []
  return sortRolesByHierarchy(Object.values(server.roles))
}

/** Можно назначить хотя бы одну роль. */
export function canManageMemberRoles(
  server: Server,
  actorMember: Member | undefined,
  actorUserId: string | undefined,
  targetMember: Member,
  actorPrivileged = false,
): boolean {
  const actorIsPrivileged = canAccessAdmin()
  if (
    !actorIsPrivileged &&
    server.owner !== actorUserId &&
    actorUserId === targetMember._id.user
  ) {
    return false
  }

  return listServerRoles(server).some((role) =>
    canAssignRole(
      server,
      actorMember,
      actorUserId,
      role.rank ?? 0,
      actorPrivileged,
    ),
  )
}

/** Можно выдать или снять хотя бы одну конкретную роль у участника. */
export function canEditAnyMemberRole(
  server: Server,
  actorMember: Member | undefined,
  actorUserId: string | undefined,
  targetMember: Member,
  actorPrivileged = false,
): boolean {
  const actorIsPrivileged = canAccessAdmin()
  if (
    !actorIsPrivileged &&
    server.owner !== actorUserId &&
    actorUserId === targetMember._id.user
  ) {
    return false
  }

  const assigned = new Set(targetMember.roles ?? [])
  return listServerRoles(server).some((role) =>
    canToggleMemberRole(
      server,
      actorMember,
      actorUserId,
      targetMember,
      role,
      !assigned.has(role._id),
      actorPrivileged,
    ),
  )
}

export function canToggleMemberRole(
  server: Server,
  actorMember: Member | undefined,
  actorUserId: string | undefined,
  targetMember: Member,
  role: Role,
  _enabled: boolean,
  actorPrivileged = false,
): boolean {
  const actorIsPrivileged = canAccessAdmin()
  if (
    !actorIsPrivileged &&
    server.owner !== actorUserId &&
    actorUserId === targetMember._id.user
  ) {
    return false
  }

  return canAssignRole(
    server,
    actorMember,
    actorUserId,
    role.rank ?? 0,
    actorPrivileged,
  )
}
