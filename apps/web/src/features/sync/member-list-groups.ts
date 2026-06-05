import type { Member, Server, User } from '@syrnike13/api-types'

import { getUserPresence, isUserOnline } from '#/lib/presence'

import type { MemberRoleEntry, ServerMemberEntry } from './selectors'
import { memberRoleEntries } from './selectors'

export function normalizeRoleColour(colour: string): string {
  const trimmed = colour.trim()
  return trimmed.startsWith('#') ? trimmed : `#${trimmed}`
}

export function memberDisplayColour(
  server: Server | undefined,
  member: Member,
): string | undefined {
  for (const role of memberRoleEntries(server, member)) {
    if (!role.colour) continue
    return normalizeRoleColour(role.colour)
  }
  return undefined
}

export function isMemberSidebarOnline(user: User): boolean {
  if (!isUserOnline(user)) return false
  return getUserPresence(user) !== 'Invisible'
}

export function memberHoistRole(
  server: Server | undefined,
  member: Member,
): MemberRoleEntry | null {
  if (!server?.roles || !member.roles?.length) return null

  let best: MemberRoleEntry | null = null
  let bestRank = -1

  for (const roleId of member.roles) {
    const role = server.roles[roleId]
    if (!role?.hoist) continue
    const rank = role.rank ?? 0
    if (rank > bestRank) {
      bestRank = rank
      best = {
        id: role._id,
        name: role.name,
        colour: role.colour ?? null,
      }
    }
  }

  return best
}

export type MemberListSection =
  | { type: 'role'; role: MemberRoleEntry; members: ServerMemberEntry[] }
  | { type: 'ungrouped'; members: ServerMemberEntry[] }
  | { type: 'offline'; members: ServerMemberEntry[] }

function memberDisplayName(entry: ServerMemberEntry): string {
  return entry.user.display_name ?? entry.user.username
}

function sortMembers(entries: ServerMemberEntry[]): ServerMemberEntry[] {
  return [...entries].sort((a, b) =>
    memberDisplayName(a).localeCompare(memberDisplayName(b)),
  )
}

export function groupServerMembersForSidebar(
  server: Server | undefined,
  members: ServerMemberEntry[],
): MemberListSection[] {
  const online: ServerMemberEntry[] = []
  const offline: ServerMemberEntry[] = []

  for (const entry of members) {
    if (isMemberSidebarOnline(entry.user)) {
      online.push(entry)
    } else {
      offline.push(entry)
    }
  }

  const roleBuckets = new Map<
    string,
    { role: MemberRoleEntry; members: ServerMemberEntry[] }
  >()
  const ungrouped: ServerMemberEntry[] = []

  for (const entry of online) {
    const hoistRole = memberHoistRole(server, entry.member)
    if (hoistRole) {
      const existing = roleBuckets.get(hoistRole.id)
      if (existing) {
        existing.members.push(entry)
      } else {
        roleBuckets.set(hoistRole.id, { role: hoistRole, members: [entry] })
      }
    } else {
      ungrouped.push(entry)
    }
  }

  const sections: MemberListSection[] = []

  const roleGroups = [...roleBuckets.values()].sort(
    (a, b) =>
      (server?.roles?.[b.role.id]?.rank ?? 0) -
      (server?.roles?.[a.role.id]?.rank ?? 0),
  )

  for (const group of roleGroups) {
    sections.push({
      type: 'role',
      role: group.role,
      members: sortMembers(group.members),
    })
  }

  if (ungrouped.length > 0) {
    sections.push({
      type: 'ungrouped',
      members: sortMembers(ungrouped),
    })
  }

  if (offline.length > 0) {
    sections.push({
      type: 'offline',
      members: sortMembers(offline),
    })
  }

  return sections
}
