import { useSyncStore } from '@syrnike13/client/sync/sync-store'
import { useTranslations } from '@syrnike13/ui/i18n'
import { Avatar } from '@syrnike13/ui-native/primitives/avatar'
import { Text } from '@syrnike13/ui-native/primitives/text'
import { router } from 'expo-router'
import { Pressable, View } from 'react-native'

import { useSession } from '../auth/session-context'
import { displayName, userStatus } from '../lib/presence'
import { mediaUrl } from '../lib/media'
import { useVoice } from '../voice/voice-provider'
import { ChevronDownIcon, Volume2BoldIcon } from './icons/registry'

/**
 * Floating user card at the bottom of the main panel (Discord mobile): avatar,
 * name and status; tapping it opens the profile.
 */
export function UserBar() {
  const t = useTranslations('mobile.userBar')
  const { session } = useSession()
  const user = useSyncStore((state) => state.users[session.userId])
  const inVoice = Boolean(useVoice().snapshot.intentChannelId)
  const status = userStatus(user)
  const name = displayName(user)

  return (
    <Pressable
      role="button"
      accessibilityLabel={t('openProfile')}
      onPress={() => router.push('/profile')}
      className="absolute right-4 bottom-4 left-4 h-14.5 flex-row items-center gap-3 rounded-2xl border border-border bg-card px-3 shadow-lg"
    >
      <Avatar size="lg" src={mediaUrl(user?.avatar)} name={name || '?'} status={status} />
      <View className="min-w-0 flex-1">
        <View className="flex-row items-center gap-1">
          <Text className="shrink font-medium" numberOfLines={1}>
            {name}
          </Text>
          <ChevronDownIcon size={16} className="text-muted-foreground" />
        </View>
        {inVoice ? (
          <View className="flex-row items-center gap-1">
            <Volume2BoldIcon size={12} className="text-success" />
            <Text className="text-xs text-success">{t('inVoice')}</Text>
          </View>
        ) : status ? (
          <Text className="text-xs text-muted-foreground">{t(`status.${status}`)}</Text>
        ) : null}
      </View>
    </Pressable>
  )
}
