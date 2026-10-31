import type { Server } from '@syrnike13/api-types'
import { listServerChannels, listServers, channelUnreadMentionCount, isChannelUnread } from '@syrnike13/client/sync/selectors'
import { syncStore, useSyncStore } from '@syrnike13/client/sync/sync-store'
import { useTranslations } from '@syrnike13/ui/i18n'
import { cn } from '@syrnike13/ui-native/lib/cn'
import { Text } from '@syrnike13/ui-native/primitives/text'
import type { ReactNode } from 'react'
import { Image, Pressable, ScrollView, View } from 'react-native'

import { useSession } from '../auth/session-context'
import { mediaUrl } from '../lib/media'
import { useVoice } from '../voice/voice-provider'
import { MessageCircleIcon, Volume2BoldIcon } from './icons/registry'

/**
 * Discord mobile server rail: 72dp wide, 60dp slots with 48dp icons. The
 * Direct Messages button comes first; a pill on the left edge marks the
 * selected server (tall) or unread activity (dot).
 */
export function ServerRail() {
  const t = useTranslations('mobile.rail')
  const servers = useSyncStore(listServers)
  const selectedId = useSyncStore((state) => state.selectedServerId)

  return (
    <ScrollView className="w-18 grow-0" contentContainerClassName="pt-1 pb-24">
      <RailSlot selected={selectedId === null} label={t('directMessages')} onPress={() => syncStore.setSelectedServerId(null)}>
        <View
          className={cn(
            'size-12 items-center justify-center rounded-2xl',
            selectedId === null ? 'bg-primary' : 'bg-card',
          )}
        >
          <MessageCircleIcon size={24} className={selectedId === null ? 'text-primary-foreground' : 'text-foreground'} />
        </View>
      </RailSlot>
      <View className="mx-auto my-1 h-0.5 w-8 rounded-full bg-border" />
      {servers.map((server) => (
        <ServerSlot key={server._id} server={server} selected={server._id === selectedId} />
      ))}
    </ScrollView>
  )
}

function ServerSlot({ server, selected }: { server: Server; selected: boolean }) {
  const { session } = useSession()
  const voice = useVoice()
  const { unread, mentions } = useSyncStore(
    (state) => {
      let unread = false
      let mentions = 0
      for (const channel of listServerChannels(state, server._id, session.userId)) {
        const entry = state.unreads[channel._id]
        unread ||= isChannelUnread(channel, entry)
        mentions += channelUnreadMentionCount(entry)
      }
      return { unread, mentions }
    },
    (a, b) => a.unread === b.unread && a.mentions === b.mentions,
  )
  const inVoice = useSyncStore((state) => {
    const id = voice.snapshot.intentChannelId
    const channel = id ? state.channels[id] : undefined
    return channel?.channel_type === 'TextChannel' && channel.server === server._id
  })
  const icon = mediaUrl(server.icon)

  return (
    <RailSlot
      selected={selected}
      unread={unread}
      label={server.name}
      onPress={() => syncStore.setSelectedServerId(server._id)}
    >
      <View className="size-12 items-center justify-center overflow-hidden rounded-2xl bg-card">
        {icon ? (
          <Image source={{ uri: icon }} className="size-full" />
        ) : (
          <Text className="font-medium">{server.name.slice(0, 2)}</Text>
        )}
      </View>
      {mentions > 0 ? (
        <View className="absolute right-2 bottom-1 min-w-5 items-center rounded-full border-2 border-background bg-destructive px-1">
          <Text className="text-xs font-bold text-destructive-foreground">{mentions}</Text>
        </View>
      ) : null}
      {inVoice ? (
        <View className="absolute top-1 right-2 size-5 items-center justify-center rounded-full border-2 border-background bg-success">
          <Volume2BoldIcon size={10} className="text-background" />
        </View>
      ) : null}
    </RailSlot>
  )
}

function RailSlot({
  selected,
  unread = false,
  label,
  onPress,
  children,
}: {
  selected: boolean
  unread?: boolean
  label: string
  onPress: () => void
  children: ReactNode
}) {
  return (
    <Pressable role="button" accessibilityLabel={label} onPress={onPress} className="h-15 w-18 flex-row items-center">
      <View
        className={cn('w-1 rounded-r-full bg-foreground', selected ? 'h-10' : unread ? 'h-2' : 'h-0')}
      />
      <View className="ml-2.5">{children}</View>
    </Pressable>
  )
}
