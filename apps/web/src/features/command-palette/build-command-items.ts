import type { Channel } from '@syrnike13/api-types'
import type { Translator } from '@syrnike13/ui/i18n'

import type { CommandItem } from '#/features/command-palette/types'
import { getChannelLabel, isTextChannel } from '#/features/sync/channel-label'
import type { SyncState } from '#/features/sync/types'
import {
  findDirectMessageChannelWithUser,
  listDmChannels,
  listServers,
  listServerChannels,
} from '#/features/sync/selectors'
import { matchScore } from '#/lib/fuzzy-match'
import { uiFeatureFlags } from '#/lib/ui-feature-flags'

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
  t: Translator
  tChat: Translator
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
  t,
  tChat,
}: BuildCommandItemsOptions): CommandItem[] {
  const items: CommandItem[] = []
  const q = query.trim()

  const navEntries = [
    { id: 'nav-home', labelKey: 'nav.home', to: '/', search: { tab: 'online' } },
    { id: 'nav-friends', labelKey: 'nav.friends', to: '/', search: { tab: 'all' } },
    { id: 'nav-settings', labelKey: 'nav.settings' },
  ] as const

  for (const entry of navEntries) {
    const label = t(entry.labelKey)
    pushItem(
      items,
      {
        id: entry.id,
        group: 'navigation',
        label,
        keywords: label,
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

  if (uiFeatureFlags.achievementDebug) {
    pushItem(
      items,
      {
        id: 'debug-achievements',
        group: 'debug',
        label: t('achievementsDebug'),
        keywords: t('achievementsDebugKeywords'),
        run: () => void navigate({ to: '/achievements-debug' }),
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
        group: 'servers',
        label: server.name,
        subtitle: t('server'),
        keywords: `${server.name} server`,
        run: () => {
          setSelectedServerId(server._id)
          const first = listServerChannels(state, server._id, currentUserId).find(
            (c) => c.channel_type === 'TextChannel',
          )
          if (first) {
            void navigate({
              to: '/c/$channelId',
              params: { channelId: first._id },
            })
          } else {
            void navigate({ to: '/' })
          }
        },
      },
      q,
    )
  }

  const channels = Object.values(state.channels).filter(isTextChannel)
  for (const channel of channels) {
    const label = getChannelLabel(channel, state.users, currentUserId, tChat)
    const server =
      channel.channel_type === 'TextChannel'
        ? state.servers[channel.server]
        : undefined
    const subtitle =
      channel.channel_type === 'DirectMessage'
        ? t('groups.dms')
        : channel.channel_type === 'TextChannel'
          ? (server?.name ?? t('channel'))
          : t('group')

    pushItem(
      items,
      {
        id: `channel-${channel._id}`,
        group:
          channel.channel_type === 'DirectMessage' ? 'dms' : 'channels',
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
            to: '/c/$channelId',
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
        group: 'friends',
        label,
        subtitle: `@${user.username}`,
        keywords: `${label} ${user.username} friend`,
        run: () => {
          setSelectedServerId(null)
          const dm = findDirectMessageChannelWithUser(
            state,
            currentUserId,
            user._id,
          )
          if (dm) {
            void navigate({
              to: '/c/$channelId',
              params: { channelId: dm._id },
            })
          } else {
            void navigate({ to: '/', search: { tab: 'all' } })
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
  currentUserId?: string,
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
    for (const channel of listServerChannels(state, server._id, currentUserId)) {
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
  currentUserId: string | undefined,
  tChat: Translator,
) {
  return getChannelLabel(channel, state.users, currentUserId, tChat)
}
