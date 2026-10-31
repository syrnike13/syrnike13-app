import type { Channel, Server, User } from '@syrnike13/api-types'
import { getChannelLabel, getDmRecipientId } from '@syrnike13/client/sync/channel-label'
import { getChannelLastMessageId, isChannelUnread, listDmChannels } from '@syrnike13/client/sync/selectors'
import { useSyncStore } from '@syrnike13/client/sync/sync-store'
import { useTranslations } from '@syrnike13/ui/i18n'
import { cn } from '@syrnike13/ui-native/lib/cn'
import { Avatar } from '@syrnike13/ui-native/primitives/avatar'
import { Text } from '@syrnike13/ui-native/primitives/text'
import { router } from 'expo-router'
import { FlatList, Pressable, ScrollView, View } from 'react-native'

import { useSession } from '../auth/session-context'
import { useOpenVoiceChannel } from '../call/voice-preview'
import { Volume2BoldIcon } from '../components/icons/registry'
import { displayName, userStatus } from '../lib/presence'
import { mediaUrl } from '../lib/media'
import { shortAge } from '../lib/relative-time'

function sameChannels(a: Channel[], b: Channel[]) {
  return a.length === b.length && a.every((channel, index) => channel === b[index])
}

type ActiveVoice = { channel: Extract<Channel, { channel_type: 'TextChannel' }>; server: Server; users: User[] }

function sameActiveVoice(a: ActiveVoice[], b: ActiveVoice[]) {
  return (
    a.length === b.length &&
    a.every(
      (item, index) =>
        item.channel === b[index]!.channel &&
        item.users.length === b[index]!.users.length &&
        item.users.every((user, userIndex) => user === b[index]!.users[userIndex]),
    )
  )
}

/** DM home: "Happening now" voice cards, then conversations newest first. */
export function DirectMessagesPanel() {
  const t = useTranslations('mobile.home')
  const { session } = useSession()
  const channels = useSyncStore(
    (state) =>
      listDmChannels(state, session.userId).sort((a, b) =>
        (getChannelLastMessageId(b) ?? '').localeCompare(getChannelLastMessageId(a) ?? ''),
      ),
    sameChannels,
  )
  const active = useSyncStore((state) => {
    const result: ActiveVoice[] = []
    for (const [channelId, participants] of Object.entries(state.voiceParticipants)) {
      const channel = state.channels[channelId]
      if (channel?.channel_type !== 'TextChannel') continue
      const server = state.servers[channel.server]
      const users = Object.keys(participants).map((id) => state.users[id]).filter((user) => user !== undefined)
      if (server && users.length > 0) result.push({ channel, server, users })
    }
    return result
  }, sameActiveVoice)

  return (
    <FlatList
      data={channels}
      keyExtractor={(channel) => channel._id}
      contentContainerClassName="pb-24"
      ListHeaderComponent={
        <View>
          <Text className="px-4 pt-4 pb-3 text-2xl font-bold">{t('directMessages')}</Text>
          {active.length > 0 ? (
            <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerClassName="gap-2 px-4 pb-4">
              {active.map((item) => (
                <ActiveVoiceCard key={item.channel._id} item={item} />
              ))}
            </ScrollView>
          ) : null}
        </View>
      }
      ListEmptyComponent={<Text className="px-4 text-muted-foreground">{t('empty')}</Text>}
      renderItem={({ item }) => <DirectMessageRow channel={item} />}
    />
  )
}

/** 264×88 "Happening now" card: stacked avatars, names, channel. */
function ActiveVoiceCard({ item }: { item: ActiveVoice }) {
  const t = useTranslations('mobile.home')
  const openVoice = useOpenVoiceChannel()
  const names = item.users.slice(0, 2).map(displayName).join(', ')
  const more = item.users.length - 2

  return (
    <Pressable
      role="button"
      onPress={() => openVoice(item.channel._id)}
      className="h-22 w-66 flex-row items-center gap-3 rounded-2xl bg-secondary px-4 active:bg-hover"
    >
      <View className="w-14 flex-row flex-wrap gap-0.5">
        {item.users.slice(0, 3).map((user) => (
          <Avatar key={user._id} size="sm" src={mediaUrl(user.avatar)} name={displayName(user)} />
        ))}
      </View>
      <View className="min-w-0 flex-1">
        <Text className="font-semibold" numberOfLines={2}>
          {more > 0 ? t('andMore', { names, count: more }) : names}
        </Text>
        <View className="flex-row items-center gap-1">
          <Volume2BoldIcon size={14} className="text-muted-foreground" />
          <Text className="text-sm text-muted-foreground" numberOfLines={1}>
            {item.channel.name}
          </Text>
        </View>
      </View>
    </Pressable>
  )
}

/** 50dp conversation row: avatar with status, name, age of the last message. */
function DirectMessageRow({ channel }: { channel: Channel }) {
  const t = useTranslations('mobile.time')
  const tChannels = useTranslations('mobile.channels')
  const { session } = useSession()
  const users = useSyncStore((state) => state.users)
  const unread = useSyncStore((state) => isChannelUnread(channel, state.unreads[channel._id]))
  const recipient = users[getDmRecipientId(channel, session.userId) ?? '']
  const label = getChannelLabel(channel, users, session.userId, tChannels)
  const lastId = getChannelLastMessageId(channel)
  const age = lastId ? shortAge(lastId) : null

  return (
    <Pressable
      role="button"
      onPress={() => router.push(`/channel/${channel._id}`)}
      className="mx-2 h-12.5 flex-row items-center gap-3 rounded-xl px-2 active:bg-hover"
    >
      <Avatar size="lg" src={mediaUrl(recipient?.avatar)} name={label} status={userStatus(recipient)} />
      <Text
        className={cn('flex-1 text-base', unread ? 'font-semibold text-foreground' : 'text-muted-foreground')}
        numberOfLines={1}
      >
        {label}
      </Text>
      {age ? <Text className="text-xs text-muted-foreground">{t(age.key, { count: age.count })}</Text> : null}
    </Pressable>
  )
}
