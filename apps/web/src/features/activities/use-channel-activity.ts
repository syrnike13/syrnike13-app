import { useCallback, useSyncExternalStore } from 'react'

import { channelActivityClient } from './channel-activity-client'

const unsubscribeNoop = () => undefined

export function useChannelActivity(channelId: string, enabled = true) {
  const subscribe = useCallback(
    (listener: () => void) => {
      if (!enabled) return unsubscribeNoop
      return channelActivityClient.subscribe(channelId, listener)
    },
    [channelId, enabled],
  )
  const getSnapshot = useCallback(
    () => channelActivityClient.snapshot(channelId),
    [channelId],
  )

  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
}
