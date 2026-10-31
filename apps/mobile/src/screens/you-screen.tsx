import { useSyncStore } from '@syrnike13/client/sync/sync-store'
import { useLocale, useTranslations } from '@syrnike13/ui/i18n'
import { Avatar } from '@syrnike13/ui-native/primitives/avatar'
import { Button } from '@syrnike13/ui-native/primitives/button'
import { Text } from '@syrnike13/ui-native/primitives/text'
import * as Application from 'expo-application'
import { ScrollView, View } from 'react-native'

import { useSession } from '../auth/session-context'
import { LogOutIcon } from '../components/icons/registry'
import { mediaUrl } from '../lib/media'

/** Profile, language and sign-out; full settings come later. */
export function YouScreen() {
  const t = useTranslations('mobile.you')
  const { locale, setLocale, locales } = useLocale()
  const { session, logout } = useSession()
  const user = useSyncStore((state) => state.users[session.userId])
  const name = user?.display_name ?? user?.username ?? ''

  return (
    <ScrollView className="flex-1 bg-background" contentContainerClassName="gap-6 p-4">
      <View className="items-center gap-2 pt-4">
        <Avatar size="xl" className="size-20" src={mediaUrl(user?.avatar)} name={name || '?'} />
        <Text className="text-xl font-semibold">{name}</Text>
        {user ? (
          <Text className="text-muted-foreground">
            {user.username}#{user.discriminator}
          </Text>
        ) : null}
      </View>

      <View className="gap-2">
        <Text className="text-xs font-semibold text-muted-foreground uppercase">{t('language')}</Text>
        <View className="flex-row gap-2">
          {locales.map((item) => (
            <Button key={item} variant={item === locale ? 'secondary' : 'outline'} onPress={() => setLocale(item)}>
              <Text>{t(`locales.${item}`)}</Text>
            </Button>
          ))}
        </View>
      </View>

      <Button variant="destructive" onPress={logout}>
        <LogOutIcon className="text-destructive" />
        <Text>{t('logout')}</Text>
      </Button>

      <Text className="text-center text-xs text-muted-foreground">
        {t('version', { version: Application.nativeApplicationVersion ?? '' })}
      </Text>
    </ScrollView>
  )
}
