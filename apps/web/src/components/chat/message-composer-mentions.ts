import type { Channel, Member, Role, Server, User } from '@syrnike13/api-types'

import {
  memberDisplayColour,
  normalizeRoleColour,
} from '#/features/sync/member-list-groups'
import type { MentionSuggestionItem } from '#/lib/message-format/extensions/mention-suggestion'
import { getMentionableUsers } from '#/lib/mentions'
import {
  calculateChannelPermissions,
  ChannelPermission,
  hasChannelPermission,
} from '#/lib/permissions'

type BuildMentionSuggestionItemsOptions = {
  query: string
  channel: Channel | undefined
  users: Record<string, User>
  members: Record<string, Member>
  server: Server | undefined
  currentUserId?: string
}

type ServerTextChannel = Extract<Channel, { channel_type: 'TextChannel' }>

function roleMatchesQuery(role: Role, query: string) {
  if (!query) return true
  return role.name.toLowerCase().includes(query)
}

function roleSuggestionColour(role: Role) {
  return role.colour ? normalizeRoleColour(role.colour) : undefined
}

function buildRoleSuggestions(
  roles: Record<string, Role> | undefined,
  query: string,
  canMentionProtectedRoles: boolean,
): MentionSuggestionItem[] {
  if (!roles) return []

  return Object.values(roles)
    .filter(
      (role) =>
        (role.mentionable !== false || canMentionProtectedRoles) &&
        roleMatchesQuery(role, query),
    )
    .sort(
      (a, b) =>
        (a.rank ?? Number.MAX_SAFE_INTEGER) -
          (b.rank ?? Number.MAX_SAFE_INTEGER) ||
        a.name.localeCompare(b.name),
    )
    .slice(0, 8)
    .map((role) => ({
      kind: 'role',
      id: role._id,
      role,
      label: `@${role.name}`,
      description: 'роль',
      colour: roleSuggestionColour(role),
    }))
}

export function buildMentionSuggestionItems({
  query,
  channel,
  users,
  members,
  server,
  currentUserId,
}: BuildMentionSuggestionItemsOptions): MentionSuggestionItem[] {
  const q = query.trim().toLowerCase()
  const isTextChannel = channel?.channel_type === 'TextChannel'
  const serverId = isTextChannel ? channel.server : undefined
  const actorMember =
    serverId && currentUserId
      ? members[`${serverId}:${currentUserId}`]
      : undefined
  const channelPermissions =
    server && isTextChannel
      ? calculateChannelPermissions(
          server,
          channel as ServerTextChannel,
          actorMember,
          currentUserId,
        )
      : 0

  const canMentionEveryone = hasChannelPermission(
    channelPermissions,
    ChannelPermission.MentionEveryone,
  )
  const canMentionProtectedRoles = hasChannelPermission(
    channelPermissions,
    ChannelPermission.MentionRoles,
  )
  const items: MentionSuggestionItem[] = []

  if (isTextChannel && canMentionEveryone) {
    if (!q || 'everyone'.startsWith(q)) {
      items.push({
        kind: 'everyone',
        label: '@everyone',
        description: 'все в канале',
      })
    }
    if (!q || 'online'.startsWith(q)) {
      items.push({
        kind: 'online',
        label: '@online',
        description: 'кто в сети',
      })
    }
  }

  if (isTextChannel && server) {
    items.push(
      ...buildRoleSuggestions(server.roles, q, canMentionProtectedRoles),
    )
  }

  const mentionable = getMentionableUsers(
    channel,
    users,
    members,
    currentUserId,
  )
  const filteredUsers = q
    ? mentionable
        .filter((user) => {
          const member =
            serverId ? members[`${serverId}:${user._id}`] : undefined
          const serverName =
            member?.nickname?.trim() || user.display_name || user.username
          return (
            user.username.toLowerCase().includes(q) ||
            user.display_name?.toLowerCase().includes(q) ||
            serverName.toLowerCase().includes(q)
          )
        })
        .slice(0, 8)
    : mentionable.slice(0, 8)

  for (const user of filteredUsers) {
    const member =
      serverId && members[`${serverId}:${user._id}`]
        ? members[`${serverId}:${user._id}`]
        : undefined
    const serverName =
      member?.nickname?.trim() || user.display_name || user.username

    items.push({
      kind: 'user',
      id: user._id,
      user,
      serverName,
      username: user.username,
      nameColour:
        server && member ? memberDisplayColour(server, member) : undefined,
    })
  }

  return items
}
