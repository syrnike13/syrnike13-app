import { useSyncStore } from '@syrnike13/client/sync/sync-store'
import { useLocale, useTranslations } from '@syrnike13/ui/i18n'
import { Avatar } from '@syrnike13/ui-native/primitives/avatar'
import { Button } from '@syrnike13/ui-native/primitives/button'
import { Text } from '@syrnike13/ui-native/primitives/text'
import * as Application from 'expo-application'
import { router } from 'expo-router'
import { ScrollView, View } from 'react-native'

import { useActiveChannelName } from '../call/call-layer'
import { useSession } from '../auth/session-context'
import { LogOutIcon, Volume2BoldIcon, XIcon } from '../components/icons/registry'
import { displayName, userStatus } from '../lib/presence'
import { mediaUrl } from '../lib/media'
import { useVoice } from '../voice/voice-provider'

/** Profile sheet opened from the user card: who you are, your call, language, sign-out. */
export function YouScreen() {
  const t = useTranslations('mobile.you')
  const { locale, setLocale, locales } = useLocale()
  const { session, logout } = useSession()
  const user = useSyncStore((state) => state.users[session.userId])
  const name = displayName(user)

  return (
    <ScrollView className="flex-1 bg-background" contentContainerClassName="gap-6 px-4 pt-2 pb-10">
      <Button variant="ghost" size="icon" accessibilityLabel={t('close')} onPress={() => router.back()}>
        <XIcon size={24} />
      </Button>

      <View className="gap-1">
        <Avatar size="2xl" src={mediaUrl(user?.avatar)} name={name || '?'} status={userStatus(user)} />
        <Text className="mt-3 text-3xl font-bold">{name}</Text>
        {user ? (
          <Text className="text-base text-muted-foreground">
            {user.username}#{user.discriminator}
          </Text>
        ) : null}
      </View>

      <VoiceCard />

      <View className="gap-3 rounded-2xl bg-card p-4">
        <Text className="font-medium">{t('language')}</Text>
        <View className="flex-row gap-2">
          {locales.map((item) => (
            <Button key={item} variant={item === locale ? 'secondary' : 'outline'} onPress={() => setLocale(item)}>
              <Text>{t(`locales.${item}`)}</Text>
            </Button>
          ))}
        </View>
      </View>

      <Button variant="destructive" size="lg" onPress={logout}>
        <LogOutIcon className="text-destructive" />
        <Text>{t('logout')}</Text>
      </Button>

      <Text className="text-center text-xs text-muted-foreground">
        {t('version', { version: Application.nativeApplicationVersion ?? '' })}
      </Text>
    </ScrollView>
  )
}

/** "In voice chat" card with a shortcut back to the call. */
function VoiceCard() {
  const t = useTranslations('mobile.you')
  const { snapshot } = useVoice()
  const channelName = useActiveChannelName()
  if (!snapshot.intentChannelId) return null
  return (
    <View className="gap-3 rounded-2xl bg-card p-4">
      <Text className="font-medium">{t('inVoice')}</Text>
      <View className="flex-row items-center gap-2">
        <Volume2BoldIcon size={18} />
        <Text className="text-base font-semibold" numberOfLines={1}>
          {channelName}
        </Text>
      </View>
      <Button variant="secondary" onPress={() => router.push('/call')}>
        <Text>{t('openVoice')}</Text>
      </Button>
    </View>
  )
}
