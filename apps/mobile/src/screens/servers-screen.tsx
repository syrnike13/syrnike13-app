import type { Server } from '@syrnike13/api-types'
import { buildChannelSidebarSections, type ServerChannel } from '@syrnike13/client/lib/channel-sidebar-layout'
import { isServerVoiceChannel } from '@syrnike13/client/lib/channel-voice'
import { isChannelUnread, listServerChannels, listServers } from '@syrnike13/client/sync/selectors'
import { syncStore, useSyncStore } from '@syrnike13/client/sync/sync-store'
import { useTranslations } from '@syrnike13/ui/i18n'
import { cn } from '@syrnike13/ui-native/lib/cn'
import { Avatar } from '@syrnike13/ui-native/primitives/avatar'
import { Button } from '@syrnike13/ui-native/primitives/button'
import { Text } from '@syrnike13/ui-native/primitives/text'
import { router } from 'expo-router'
import { useMemo } from 'react'
import { Image, Pressable, ScrollView, View } from 'react-native'

import { useSession } from '../auth/session-context'
import { HashIcon, Volume2BoldIcon } from '../components/icons/registry'
import { mediaUrl } from '../lib/media'
import { useVoice } from '../voice/voice-provider'

/** Discord mobile home: server rail on the left, the server's channels on the right. */
export function ServersScreen() {
  const { session } = useSession()
  const servers = useSyncStore(listServers)
  const selectedId = useSyncStore((state) => state.selectedServerId)
  const server = servers.find((item) => item._id === selectedId) ?? servers[0]

  return (
    <View className="flex-1 flex-row bg-background">
      <ScrollView className="w-18 grow-0" contentContainerClassName="items-center gap-2 py-3">
        {servers.map((item) => (
          <ServerRailItem
            key={item._id}
            server={item}
            selected={item._id === server?._id}
            onPress={() => syncStore.setSelectedServerId(item._id)}
          />
        ))}
      </ScrollView>
      <View className="flex-1 overflow-hidden rounded-tl-2xl bg-card">
        {server ? <ChannelList server={server} userId={session.userId} /> : null}
      </View>
    </View>
  )
}

/** 48px server icon; the selected server turns into a rounded square with a pill. */
function ServerRailItem({ server, selected, onPress }: { server: Server; selected: boolean; onPress: () => void }) {
  const icon = mediaUrl(server.icon)
  return (
    <Pressable role="button" accessibilityLabel={server.name} onPress={onPress} className="w-18 flex-row items-center">
      <View className={cn('w-1 rounded-r-full bg-foreground', selected ? 'h-10' : 'h-0')} />
      <View
        className={cn(
          'ml-2.5 size-12 items-center justify-center overflow-hidden bg-muted',
          selected ? 'rounded-2xl' : 'rounded-full',
        )}
      >
        {icon ? (
          <Image source={{ uri: icon }} className="size-full" />
        ) : (
          <Text className="font-medium">{server.name.slice(0, 2)}</Text>
        )}
      </View>
    </Pressable>
  )
}

function ChannelList({ server, userId }: { server: Server; userId: string }) {
  // listServerChannels caches its list, so this selector stays referentially stable.
  const channels = useSyncStore((state) => listServerChannels(state, server._id, userId))
  const sections = useMemo(() => buildChannelSidebarSections(server, channels), [server, channels])
  return (
    <ScrollView contentContainerClassName="pb-4">
      <Text className="px-4 pt-4 pb-2 text-lg font-semibold" numberOfLines={1}>
        {server.name}
      </Text>
      {sections.map((section) => (
        <View key={section.id} className="mt-3">
          {section.title ? (
            <Text className="px-4 pb-1 text-xs font-semibold text-muted-foreground uppercase">
              {section.title}
            </Text>
          ) : null}
          {section.channels.map((channel) =>
            isServerVoiceChannel(channel) ? (
              <VoiceChannelRow key={channel._id} channel={channel} />
            ) : (
              <TextChannelRow key={channel._id} channel={channel} />
            ),
          )}
        </View>
      ))}
    </ScrollView>
  )
}

function TextChannelRow({ channel }: { channel: ServerChannel }) {
  const unread = useSyncStore((state) => isChannelUnread(channel, state.unreads[channel._id]))
  return (
    <Button
      variant="ghost"
      className="mx-2 justify-start"
      onPress={() => router.push(`/channel/${channel._id}`)}
    >
      <HashIcon className={unread ? 'text-foreground' : 'text-muted-foreground'} />
      <Text className={unread ? 'text-foreground' : 'text-muted-foreground'} numberOfLines={1}>
        {channel.name}
      </Text>
    </Button>
  )
}

function VoiceChannelRow({ channel }: { channel: ServerChannel }) {
  const t = useTranslations('mobile.voice')
  const voice = useVoice()
  const participants = useSyncStore((state) => {
    const ids = Object.keys(state.voiceParticipants[channel._id] ?? {})
    return ids.map((id) => state.users[id]).filter((user) => user !== undefined)
  }, sameUsers)
  const active = voice.snapshot.intentChannelId === channel._id

  async function open() {
    if (active || (await voice.join(channel._id))) router.push('/call')
  }

  return (
    <View>
      <Button
        variant={active ? 'secondary' : 'ghost'}
        className="mx-2 justify-start"
        accessibilityLabel={t('join', { channel: channel.name })}
        onPress={open}
      >
        <Volume2BoldIcon size={18} className="text-muted-foreground" />
        <Text className="text-muted-foreground" numberOfLines={1}>
          {channel.name}
        </Text>
      </Button>
      {participants.map((user) => (
        <View key={user._id} className="ml-12 flex-row items-center gap-2 py-1">
          <Avatar size="sm" src={mediaUrl(user.avatar)} name={user.display_name ?? user.username} />
          <Text className="text-sm text-muted-foreground" numberOfLines={1}>
            {user.display_name ?? user.username}
          </Text>
        </View>
      ))}
    </View>
  )
}

function sameUsers<T extends { _id: string }>(a: T[], b: T[]) {
  return a.length === b.length && a.every((user, index) => user === b[index])
}
