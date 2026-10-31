import { router } from 'expo-router'
import { useEffect } from 'react'

import { useActiveChannelName } from '../call/call-layer'
import { CallScreen } from '../call/call-screen'
import { useVoice } from '../voice/voice-provider'

/** The full call stage; leaving it keeps the call in the floating window. */
export default function CallRoute() {
  const { director, snapshot, room } = useVoice()
  const channelName = useActiveChannelName()
  const active = Boolean(room && snapshot.intentChannelId)

  useEffect(() => {
    if (!active && router.canGoBack()) router.back()
  }, [active])

  if (!active) return null
  return (
    <CallScreen
      director={director}
      snapshot={snapshot}
      channelName={channelName}
      onMinimize={() => router.back()}
    />
  )
}
