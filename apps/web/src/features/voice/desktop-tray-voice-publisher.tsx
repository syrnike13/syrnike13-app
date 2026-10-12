import { useEffect, useMemo } from 'react'
import { Effect, Semaphore } from 'effect'

import { useAuth } from '#/features/auth/auth-context'
import { useSyncStore } from '#/features/sync/sync-store'
import { usePlatform } from '#/platform/use-platform'

import { useVoiceSession } from './voice-session-context'
import { deriveDesktopTrayVoiceState } from './voice-tray-state'

const trayVoiceStateWrite = Semaphore.makeUnsafe(1)

export function DesktopTrayVoicePublisher() {
  const auth = useAuth()
  const voice = useVoiceSession()
  const { desktop } = usePlatform()

  const localParticipant = useSyncStore((state) => {
    const userId = auth.user?._id
    if (!voice.channelId || !userId) return null
    return state.voiceParticipants[voice.channelId]?.[userId] ?? null
  })

  const trayState = useMemo(
    () =>
      deriveDesktopTrayVoiceState({
        channelId: voice.channelId,
        currentUserId: auth.user?._id ?? null,
        localParticipant,
        speakingUserIds: voice.speakingUserIds,
      }),
    [auth.user?._id, localParticipant, voice.channelId, voice.speakingUserIds],
  )

  useEffect(() => {
    if (!desktop) return

    Effect.runFork(
      trayVoiceStateWrite.withPermit(
        Effect.tryPromise({
          try: () => desktop.tray.setVoiceState(trayState),
          catch: (cause) => cause,
        }).pipe(
          Effect.catch((error) =>
            Effect.sync(() => {
              console.error('[desktop-tray] voice state failed', error)
            }),
          ),
        ),
      ),
    )
  }, [desktop, trayState])

  useEffect(() => {
    if (!desktop) return
    return () => {
      Effect.runFork(
        trayVoiceStateWrite.withPermit(
          Effect.tryPromise({
            try: () => desktop.tray.setVoiceState('default'),
            catch: (cause) => cause,
          }).pipe(Effect.ignore),
        ),
      )
    }
  }, [desktop])

  return null
}
