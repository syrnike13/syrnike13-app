import type { Server } from '@syrnike13/api-types'
import {
  buildChannelSidebarSections,
  type ChannelSidebarSection,
  type ServerChannel,
} from '@syrnike13/client/lib/channel-sidebar-layout'
import { isServerVoiceChannel } from '@syrnike13/client/lib/channel-voice'
import { channelUnreadMentionCount, isChannelUnread, listServerChannels } from '@syrnike13/client/sync/selectors'
import { useSyncStore } from '@syrnike13/client/sync/sync-store'
import { useTranslations } from '@syrnike13/ui/i18n'
import { cn } from '@syrnike13/ui-native/lib/cn'
import { Avatar } from '@syrnike13/ui-native/primitives/avatar'
import { Button } from '@syrnike13/ui-native/primitives/button'
import { Text } from '@syrnike13/ui-native/primitives/text'
import { router } from 'expo-router'
import { useMemo, useState, type ReactNode } from 'react'
import { Pressable, ScrollView, View } from 'react-native'

import { useSession } from '../auth/session-context'
import { useOpenVoiceChannel } from '../call/voice-preview'
import {
  ChevronDownIcon,
  ChevronRightIcon,
  HashIcon,
  UserPlusIcon,
  Volume2BoldIcon,
} from '../components/icons/registry'
import { displayName } from '../lib/presence'
import { mediaUrl } from '../lib/media'
import { InviteSheet, ServerInfoSheet } from '../servers/server-sheets'
import { useVoiceChannelUsers } from '../voice/voice-channel-users'
import { useVoice } from '../voice/voice-provider'

/** The selected server: name header, then channels by category (Discord mobile metrics). */
export function ServerPanel({ server }: { server: Server }) {
  const { session } = useSession()
  // listServerChannels caches its list, so this selector stays referentially stable.
  const channels = useSyncStore((state) => listServerChannels(state, server._id, session.userId))
  const sections = useMemo(() => buildChannelSidebarSections(server, channels), [server, channels])
  const t = useTranslations('mobile.server')
  const [sheet, setSheet] = useState<'info' | 'invite' | null>(null)
  // Invites point at a text channel, as on the web: the first one.
  const inviteChannelId = channels.find((channel) => !isServerVoiceChannel(channel))?._id

  return (
    <ScrollView contentContainerClassName="pb-24">
      <Pressable
        role="button"
        accessibilityLabel={t('info')}
        onPress={() => setSheet('info')}
        className="flex-row items-center gap-1 px-4 pt-4 pb-3"
      >
        <Text className="shrink text-xl font-bold" numberOfLines={1}>
          {server.name}
        </Text>
        <ChevronRightIcon size={18} className="text-muted-foreground" />
      </Pressable>
      <View className="flex-row px-4 pb-3">
        <Button variant="secondary" size="sm" onPress={() => setSheet('invite')}>
          <UserPlusIcon size={16} />
          <Text className="text-sm font-semibold">{t('invite')}</Text>
        </Button>
      </View>
      <View className="mx-4 mb-2 h-px bg-border" />
      {sections.map((section) => (
        <CategorySection key={section.id} section={section} />
      ))}
      {sheet === 'info' ? (
        <ServerInfoSheet server={server} onClose={() => setSheet(null)} onInvite={() => setSheet('invite')} />
      ) : null}
      {sheet === 'invite' ? (
        <InviteSheet server={server} channelId={inviteChannelId} onClose={() => setSheet(null)} />
      ) : null}
    </ScrollView>
  )
}

/** Sentence-case title with a chevron; collapsed categories keep unread channels visible. */
function CategorySection({ section }: { section: ChannelSidebarSection }) {
  const [collapsed, setCollapsed] = useState(false)
  const unreads = useSyncStore((state) => state.unreads)
  const visible = collapsed
    ? section.channels.filter((channel) => isChannelUnread(channel, unreads[channel._id]))
    : section.channels

  return (
    <View className="mt-3">
      {section.title ? (
        <Pressable
          role="button"
          onPress={() => setCollapsed((value) => !value)}
          className="h-7 flex-row items-center gap-1 px-4"
        >
          <Text className="text-sm font-medium text-muted-foreground" numberOfLines={1}>
            {section.title}
          </Text>
          {collapsed ? (
            <ChevronRightIcon size={14} className="text-muted-foreground" />
          ) : (
            <ChevronDownIcon size={14} className="text-muted-foreground" />
          )}
        </Pressable>
      ) : null}
      {visible.map((channel) =>
        isServerVoiceChannel(channel) ? (
          <VoiceChannelRow key={channel._id} channel={channel} />
        ) : (
          <TextChannelRow key={channel._id} channel={channel} />
        ),
      )}
    </View>
  )
}

/** 36dp row inset 8; unread channels use the foreground colour and a pill on the panel edge. */
function ChannelRow({
  icon,
  name,
  unread,
  active = false,
  trailing,
  onPress,
}: {
  icon: ReactNode
  name: string
  unread: boolean
  active?: boolean
  trailing?: ReactNode
  onPress: () => void
}) {
  return (
    <View className="relative">
      {unread ? <View className="absolute top-3.5 left-0 h-2 w-1 rounded-r-full bg-foreground" /> : null}
      <Pressable
        role="button"
        onPress={onPress}
        className={cn('mx-2 h-9 flex-row items-center gap-2 rounded-lg px-2 active:bg-hover', active && 'bg-hover')}
      >
        {icon}
        <Text
          className={cn('flex-1 text-base', unread || active ? 'font-medium text-foreground' : 'text-muted-foreground')}
          numberOfLines={1}
        >
          {name}
        </Text>
        {trailing}
      </Pressable>
    </View>
  )
}

function TextChannelRow({ channel }: { channel: ServerChannel }) {
  const unread = useSyncStore((state) => isChannelUnread(channel, state.unreads[channel._id]))
  const mentions = useSyncStore((state) => channelUnreadMentionCount(state.unreads[channel._id]))
  return (
    <ChannelRow
      icon={<HashIcon className={unread ? 'text-foreground' : 'text-muted-foreground'} />}
      name={channel.name}
      unread={unread}
      onPress={() => router.push(`/channel/${channel._id}`)}
      trailing={
        mentions > 0 ? (
          <View className="min-w-5 items-center rounded-full bg-destructive px-1.5">
            <Text className="text-xs font-bold text-destructive-foreground">{mentions}</Text>
          </View>
        ) : null
      }
    />
  )
}

/** Voice channel with the people in it listed underneath; your own channel turns green. */
function VoiceChannelRow({ channel }: { channel: ServerChannel }) {
  const openVoice = useOpenVoiceChannel()
  const own = useVoice().snapshot.intentChannelId === channel._id
  const users = useVoiceChannelUsers(channel._id)

  return (
    <View>
      <ChannelRow
        icon={<Volume2BoldIcon size={18} className={own ? 'text-success' : 'text-muted-foreground'} />}
        name={channel.name}
        unread={false}
        active={own}
        onPress={() => openVoice(channel._id)}
      />
      {users.map((user) => (
        <View key={user._id} className="ml-11 flex-row items-center gap-2 py-1">
          <Avatar size="sm" src={mediaUrl(user.avatar)} name={displayName(user)} />
          <Text className="text-sm text-muted-foreground" numberOfLines={1}>
            {displayName(user)}
          </Text>
        </View>
      ))}
    </View>
  )
}
