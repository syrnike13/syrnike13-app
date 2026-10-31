import { useTranslations } from '@syrnike13/ui/i18n'
import { Text } from '@syrnike13/ui-native/primitives/text'
import { router } from 'expo-router'
import { useEffect } from 'react'
import { View } from 'react-native'

import { useActiveChannelName } from '../call/call-layer'
import { CallScreen } from '../call/call-screen'
import { useVoice } from '../voice/voice-provider'

/** The full call stage; leaving it keeps the call in the floating window. */
export default function CallRoute() {
  const t = useTranslations('mobile.voice')
  const { director, snapshot, room } = useVoice()
  const channelName = useActiveChannelName()
  const inCall = Boolean(snapshot.intentChannelId)

  // Close only once the call is over; right after joining the room is not up yet.
  useEffect(() => {
    if (!inCall && router.canGoBack()) router.back()
  }, [inCall])

  if (!inCall) return null
  if (!room) {
    return (
      <View className="flex-1 items-center justify-center bg-background">
        <Text className="text-muted-foreground">{t(`connection.${snapshot.connection}`)}</Text>
      </View>
    )
  }
  return (
    <CallScreen
      director={director}
      snapshot={snapshot}
      channelName={channelName}
      onMinimize={() => router.back()}
    />
  )
}
