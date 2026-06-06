import type { Channel } from '@syrnike13/api-types'

import type { CommandItem } from '#/features/command-palette/types'
import { getChannelLabel, isTextChannel } from '#/features/sync/channel-label'
import type { SyncState } from '#/features/sync/types'
import { listDmChannels, listServers, listServerChannels } from '#/features/sync/selectors'
import { matchScore } from '#/lib/fuzzy-match'

type BuildCommandItemsOptions = {
  state: SyncState
  currentUserId?: string
  query: string
  activeChannelId?: string
  navigate: (opts: {
    to: string
    params?: Record<string, string>
    search?: Record<string, string>
  }) => void | Promise<void>
  setSelectedServerId: (id: string | null) => void
  openSettings?: () => void
}

function itemScore(label: string, subtitle: string | undefined, keywords: string, query: string) {
  const base = matchScore(label, query)
  const sub = subtitle ? matchScore(subtitle, query) * 0.8 : 0
  const extra = matchScore(keywords, query) * 0.6
  return Math.max(base, sub, extra)
}

function pushItem(
  items: CommandItem[],
  partial: Omit<CommandItem, 'score'> & { score?: number },
  query: string,
) {
  const score =
    partial.score ??
    itemScore(partial.label, partial.subtitle, partial.keywords, query)
  if (query.trim() && score <= 0) return
  items.push({ ...partial, score })
}

export function buildCommandItems({
  state,
  currentUserId,
  query,
  activeChannelId,
  navigate,
  setSelectedServerId,
  openSettings,
}: BuildCommandItemsOptions): CommandItem[] {
  const items: CommandItem[] = []
  const q = query.trim()

  const navEntries = [
    { id: 'nav-home', label: 'Главная', to: '/app', search: { tab: 'online' } },
    { id: 'nav-friends', label: 'Друзья', to: '/app', search: { tab: 'all' } },
    { id: 'nav-settings', label: 'Настройки' },
  ] as const

  for (const entry of navEntries) {
    pushItem(
      items,
      {
        id: entry.id,
        group: 'Навигация',
        label: entry.label,
        keywords: entry.label,
        run: () => {
          if (entry.id === 'nav-settings') {
            openSettings?.()
            return
          }
          if ('to' in entry) {
            if ('search' in entry && entry.search) {
              void navigate({ to: entry.to, search: entry.search })
            } else {
              void navigate({ to: entry.to })
            }
          }
          if (entry.id === 'nav-home' || entry.id === 'nav-friends') {
            setSelectedServerId(null)
          }
        },
      },
      q,
    )
  }

  const servers = listServers(state)
  for (const server of servers) {
    pushItem(
      items,
      {
        id: `server-${server._id}`,
        group: 'Серверы',
        label: server.name,
        subtitle: 'Сервер',
        keywords: `${server.name} server`,
        run: () => {
          setSelectedServerId(server._id)
          const first = listServerChannels(state, server._id).find(
            (c) => c.channel_type === 'TextChannel',
          )
          if (first) {
            void navigate({
              to: '/app/c/$channelId',
              params: { channelId: first._id },
            })
          } else {
            void navigate({ to: '/app' })
          }
        },
      },
      q,
    )
  }

  const channels = Object.values(state.channels).filter(isTextChannel)
  for (const channel of channels) {
    const label = getChannelLabel(channel, state.users, currentUserId)
    const server =
      channel.channel_type === 'TextChannel'
        ? state.servers[channel.server]
        : undefined
    const subtitle =
      channel.channel_type === 'DirectMessage'
        ? 'Личные сообщения'
        : channel.channel_type === 'TextChannel'
          ? (server?.name ?? 'Канал')
          : 'Группа'

    pushItem(
      items,
      {
        id: `channel-${channel._id}`,
        group:
          channel.channel_type === 'DirectMessage'
            ? 'Личные сообщения'
            : 'Каналы',
        label:
          channel.channel_type === 'TextChannel' ? `# ${label}` : label,
        subtitle,
        keywords: `${label} ${subtitle} ${channel._id}`,
        score:
          channel._id === activeChannelId
            ? itemScore(label, subtitle, label, q) + 30
            : undefined,
        run: () => {
          if (channel.channel_type === 'TextChannel') {
            setSelectedServerId(channel.server)
          } else {
            setSelectedServerId(null)
          }
          void navigate({
            to: '/app/c/$channelId',
            params: { channelId: channel._id },
          })
        },
      },
      q,
    )
  }

  const friends = Object.values(state.users).filter(
    (user) => user.relationship === 'Friend' && user._id !== currentUserId,
  )
  for (const user of friends) {
    const label = user.display_name ?? user.username
    pushItem(
      items,
      {
        id: `friend-${user._id}`,
        group: 'Друзья',
        label,
        subtitle: `@${user.username}`,
        keywords: `${label} ${user.username} friend`,
        run: () => {
          setSelectedServerId(null)
          const dm = listDmChannels(state, currentUserId).find((channel) => {
            if (channel.channel_type !== 'DirectMessage') return false
            return channel.recipients.includes(user._id)
          })
          if (dm) {
            void navigate({
              to: '/app/c/$channelId',
              params: { channelId: dm._id },
            })
          } else {
            void navigate({ to: '/app', search: { tab: 'all' } })
          }
        },
      },
      q,
    )
  }

  return items
    .sort((a, b) => b.score - a.score)
    .slice(0, 40)
}

export function messageSearchChannelIds(
  state: SyncState,
  activeChannelId?: string,
  limit = 5,
): string[] {
  const ids: string[] = []
  if (activeChannelId && state.channels[activeChannelId]) {
    ids.push(activeChannelId)
  }
  for (const channel of listDmChannels(state)) {
    if (ids.length >= limit) break
    if (!ids.includes(channel._id)) ids.push(channel._id)
  }
  for (const server of listServers(state)) {
    for (const channel of listServerChannels(state, server._id)) {
      if (channel.channel_type !== 'TextChannel') continue
      if (ids.length >= limit) break
      if (!ids.includes(channel._id)) ids.push(channel._id)
    }
    if (ids.length >= limit) break
  }
  return ids.slice(0, limit)
}

export function channelLabelForMessage(
  channel: Channel,
  state: SyncState,
  currentUserId?: string,
) {
  return getChannelLabel(channel, state.users, currentUserId)
}
