import type { Member, Role, Server } from '@syrnike13/api-types'

import {
  canAssignRole,
  canEditMember,
} from '#/lib/permissions'
import { sortRolesByHierarchy } from '#/lib/server-permissions'

export function listServerRoles(server: Server | undefined): Role[] {
  if (!server?.roles) return []
  return sortRolesByHierarchy(Object.values(server.roles))
}

/** Можно назначить хотя бы одну роль (устаревший критерий для «есть доступ к ролям»). */
export function canManageMemberRoles(
  server: Server,
  actorMember: Member | undefined,
  actorUserId: string | undefined,
  targetMember: Member,
): boolean {
  if (server.owner !== actorUserId && actorUserId === targetMember._id.user) {
    return false
  }

  if (!canEditMember(server, actorMember, actorUserId, targetMember)) {
    return false
  }

  if (server.owner === actorUserId) return true

  return listServerRoles(server).some((role) =>
    canAssignRole(server, actorMember, actorUserId, role.rank ?? 0),
  )
}

/** Можно выдать или снять хотя бы одну конкретную роль у участника. */
export function canEditAnyMemberRole(
  server: Server,
  actorMember: Member | undefined,
  actorUserId: string | undefined,
  targetMember: Member,
): boolean {
  if (server.owner !== actorUserId && actorUserId === targetMember._id.user) {
    return false
  }

  if (!canEditMember(server, actorMember, actorUserId, targetMember)) {
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
    ),
  )
}

export function canToggleMemberRole(
  server: Server,
  actorMember: Member | undefined,
  actorUserId: string | undefined,
  targetMember: Member,
  role: Role,
  enabled: boolean,
): boolean {
  if (server.owner !== actorUserId && actorUserId === targetMember._id.user) {
    return false
  }

  if (!canEditMember(server, actorMember, actorUserId, targetMember)) {
    return false
  }

  if (enabled) {
    return canAssignRole(
      server,
      actorMember,
      actorUserId,
      role.rank ?? 0,
    )
  }

  if (server.owner === actorUserId) return true
  return canAssignRole(server, actorMember, actorUserId, role.rank ?? 0)
}
