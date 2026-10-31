import type { Channel } from '@syrnike13/api-types'
import { getChannelLabel, getDmRecipientId } from '@syrnike13/client/sync/channel-label'
import { isChannelUnread, listDmChannels } from '@syrnike13/client/sync/selectors'
import { useSyncStore } from '@syrnike13/client/sync/sync-store'
import { useTranslations } from '@syrnike13/ui/i18n'
import { Avatar } from '@syrnike13/ui-native/primitives/avatar'
import { Button } from '@syrnike13/ui-native/primitives/button'
import { Text } from '@syrnike13/ui-native/primitives/text'
import { router } from 'expo-router'
import { FlatList, View } from 'react-native'

import { useSession } from '../auth/session-context'
import { mediaUrl } from '../lib/media'

function sameChannels(a: Channel[], b: Channel[]) {
  return a.length === b.length && a.every((channel, index) => channel === b[index])
}

export function DirectMessagesScreen() {
  const t = useTranslations('mobile.messages')
  const tChannels = useTranslations('mobile.channels')
  const { session } = useSession()
  const channels = useSyncStore((state) => listDmChannels(state, session.userId), sameChannels)
  const users = useSyncStore((state) => state.users)
  const unreads = useSyncStore((state) => state.unreads)

  return (
    <View className="flex-1 bg-background">
      <Text className="px-4 pt-4 pb-2 text-2xl font-semibold">{t('title')}</Text>
      <FlatList
        data={channels}
        keyExtractor={(channel) => channel._id}
        ListEmptyComponent={<Text className="p-4 text-muted-foreground">{t('empty')}</Text>}
        renderItem={({ item: channel }) => {
          const recipient = users[getDmRecipientId(channel, session.userId) ?? '']
          const label = getChannelLabel(channel, users, session.userId, tChannels)
          const unread = isChannelUnread(channel, unreads[channel._id])
          return (
            <Button
              variant="ghost"
              size="lg"
              className="mx-2 h-14 justify-start gap-3"
              onPress={() => router.push(`/channel/${channel._id}`)}
            >
              <Avatar size="lg" src={mediaUrl(recipient?.avatar)} name={label} />
              <Text className={unread ? 'font-semibold text-foreground' : 'text-muted-foreground'} numberOfLines={1}>
                {label}
              </Text>
            </Button>
          )
        }}
      />
    </View>
  )
}
