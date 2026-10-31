import { useTranslations } from '@syrnike13/ui/i18n'
import { Avatar } from '@syrnike13/ui-native/primitives/avatar'
import { Button } from '@syrnike13/ui-native/primitives/button'
import { Input } from '@syrnike13/ui-native/primitives/input'
import { Text } from '@syrnike13/ui-native/primitives/text'
import { router } from 'expo-router'
import { useMemo, useState } from 'react'
import { FlatList, Pressable, View } from 'react-native'

import { XIcon } from '../components/icons/registry'
import { useOpenDirectMessage, useUsersByRelationship } from '../lib/direct-messages'
import { mediaUrl } from '../lib/media'
import { displayName, userStatus } from '../lib/presence'

/** Discord's "New message": search your friends and open the DM with one. */
export function NewMessageScreen() {
  const t = useTranslations('mobile.newMessage')
  const friends = useUsersByRelationship('Friend')
  const openDm = useOpenDirectMessage()
  const [query, setQuery] = useState('')

  const matches = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase()
    if (!needle) return friends
    return friends.filter((user) =>
      [user.username, user.display_name ?? ''].some((value) => value.toLocaleLowerCase().includes(needle)),
    )
  }, [friends, query])

  return (
    <View className="flex-1 bg-background">
      <View className="h-14 flex-row items-center gap-2 pr-4 pl-2">
        <Button variant="ghost" size="icon-lg" accessibilityLabel={t('close')} onPress={() => router.back()}>
          <XIcon size={24} />
        </Button>
        <Text className="text-lg font-semibold">{t('title')}</Text>
      </View>
      <View className="px-4 pb-3">
        <Input value={query} onChangeText={setQuery} placeholder={t('search')} autoCapitalize="none" autoFocus />
      </View>
      <FlatList
        data={matches}
        keyExtractor={(user) => user._id}
        keyboardShouldPersistTaps="handled"
        ListEmptyComponent={
          <Text className="p-8 text-center text-muted-foreground">{t(friends.length ? 'noMatches' : 'noFriends')}</Text>
        }
        renderItem={({ item }) => (
          <Pressable
            className="mx-2 h-14 flex-row items-center gap-3 rounded-xl px-2 active:bg-hover"
            onPress={() => void openDm(item._id, { replace: true })}
          >
            <Avatar size="lg" src={mediaUrl(item.avatar)} name={displayName(item)} status={userStatus(item)} />
            <View className="min-w-0 flex-1">
              <Text className="font-medium" numberOfLines={1}>
                {displayName(item)}
              </Text>
              <Text className="text-xs text-muted-foreground" numberOfLines={1}>
                {item.username}
              </Text>
            </View>
          </Pressable>
        )}
      />
    </View>
  )
}
