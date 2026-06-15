import { useEffect } from 'react'

import { useAuth } from '#/features/auth/auth-context'
import { eventsGateway } from '#/features/events/gateway'
import { syncStore } from '#/features/sync/sync-store'
import { usePlatform } from '#/platform/use-platform'

export function MusicPresenceManager() {
  const auth = useAuth()
  const { desktop } = usePlatform()

  useEffect(() => {
    const userId = auth.user?._id
    if (!userId || !desktop) return

    let cancelled = false

    function publishPresence(presence: Parameters<typeof eventsGateway.musicPresence>[0]) {
      const activePresence = presence?.isPlaying ? presence : null
      syncStore.setUserMusicPresence(userId, activePresence)
      eventsGateway.musicPresence(activePresence)
    }

    void desktop.music.getCurrentPresence().then((presence) => {
      if (!cancelled) publishPresence(presence)
    })

    const unsubscribe = desktop.music.onPresenceChange((presence) => {
      publishPresence(presence)
    })

    return () => {
      cancelled = true
      unsubscribe()
      publishPresence(null)
    }
  }, [auth.user?._id, desktop])

  return null
}
