import { useEffect, useMemo } from 'react'

import { useAuth } from '#/features/auth/auth-context'
import { useSyncStore } from '#/features/sync/sync-store'
import type { UserVoiceState } from '#/features/sync/voice-types'
import { usePlatform } from '#/platform/use-platform'

import { useVoiceSession } from './voice-session-context'
import { deriveDesktopTrayVoiceState } from './voice-tray-state'

export function DesktopTrayVoicePublisher() {
  const auth = useAuth()
  const voice = useVoiceSession()
  const { desktop } = usePlatform()

  const localParticipant = useSyncStore((state) => {
    const userId = auth.user?._id
    if (!voice.channelId || !userId) return null
    return state.voiceParticipants[voice.channelId]?.[userId] ?? null
  }) as UserVoiceState | null

  const trayState = useMemo(
    () =>
      deriveDesktopTrayVoiceState({
        channelId: voice.channelId,
        currentUserId: auth.user?._id,
        localParticipant,
        speakingUserIds: voice.speakingUserIds,
      }),
    [auth.user?._id, localParticipant, voice.channelId, voice.speakingUserIds],
  )

  useEffect(() => {
    if (!desktop) return

    let cancelled = false
    void desktop.tray.setVoiceState(trayState).catch((error) => {
      if (!cancelled) console.error('[desktop-tray] voice state failed', error)
    })

    return () => {
      cancelled = true
    }
  }, [desktop, trayState])

  useEffect(() => {
    if (!desktop) return
    return () => {
      void desktop.tray.setVoiceState('default')
    }
  }, [desktop])

  return null
}
