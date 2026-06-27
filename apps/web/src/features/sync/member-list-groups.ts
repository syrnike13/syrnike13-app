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
  let bestRank = Number.MAX_SAFE_INTEGER

  for (const roleId of member.roles) {
    const role = server.roles[roleId]
    if (!role?.hoist) continue
    const rank = role.rank ?? Number.MAX_SAFE_INTEGER
    if (rank < bestRank) {
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
  /** Онлайн-участники без отдельной hoist-роли. */
  | { type: 'online'; members: ServerMemberEntry[] }
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
  const onlineWithoutHoist: ServerMemberEntry[] = []

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
      onlineWithoutHoist.push(entry)
    }
  }

  const sections: MemberListSection[] = []

  const roleGroups = [...roleBuckets.values()].sort(
    (a, b) =>
      (server?.roles?.[a.role.id]?.rank ?? Number.MAX_SAFE_INTEGER) -
      (server?.roles?.[b.role.id]?.rank ?? Number.MAX_SAFE_INTEGER),
  )

  for (const group of roleGroups) {
    sections.push({
      type: 'role',
      role: group.role,
      members: sortMembers(group.members),
    })
  }

  if (onlineWithoutHoist.length > 0) {
    sections.push({
      type: 'online',
      members: sortMembers(onlineWithoutHoist),
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

export type MemberSidebarListItem =
  | { kind: 'header'; key: string; title: string; count: number }
  | {
      kind: 'member'
      key: string
      entry: ServerMemberEntry
      sectionType: 'role' | 'online' | 'offline'
    }

/** Плоский список для сайдбара: участники не размонтируются при смене секции. */
export function flattenMemberListSections(
  sections: MemberListSection[],
): MemberSidebarListItem[] {
  const items: MemberSidebarListItem[] = []

  for (const section of sections) {
    if (section.type === 'role') {
      items.push({
        kind: 'header',
        key: `header-role-${section.role.id}`,
        title: section.role.name,
        count: section.members.length,
      })
    } else if (section.type === 'online') {
      items.push({
        kind: 'header',
        key: 'header-online',
        title: 'В сети',
        count: section.members.length,
      })
    } else {
      items.push({
        kind: 'header',
        key: 'header-offline',
        title: 'Не в сети',
        count: section.members.length,
      })
    }

    const sectionType =
      section.type === 'role' ? 'role' : section.type

    for (const entry of section.members) {
      items.push({
        kind: 'member',
        key: entry.user._id,
        entry,
        sectionType,
      })
    }
  }

  return items
}
