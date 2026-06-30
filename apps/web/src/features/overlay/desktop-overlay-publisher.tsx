import { useEffect, useMemo } from 'react'

import { useAuth } from '#/features/auth/auth-context'
import { getChannelLabel } from '#/features/sync/channel-label'
import { useSyncStore } from '#/features/sync/sync-store'
import type { UserVoiceState } from '#/features/sync/voice-types'
import { useVoiceSession } from '#/features/voice/voice-session-context'
import { usePlatform } from '#/platform/use-platform'

import { buildVoiceOverlaySnapshot } from './voice-overlay-snapshot'

const EMPTY_PARTICIPANTS: UserVoiceState[] = []

export function DesktopOverlayPublisher() {
  const auth = useAuth()
  const voice = useVoiceSession()
  const { desktop, os } = usePlatform()
  const overlayInput = useSyncStore((state) => {
    if (!voice.channelId) {
      return {
        channelLabel: null,
        participants: EMPTY_PARTICIPANTS,
        users: state.users,
      }
    }

    const channel = state.channels[voice.channelId]
    return {
      channelLabel:
        channel && auth.user
          ? getChannelLabel(channel, state.users, auth.user._id)
          : 'Голосовой канал',
      participants: Object.values(
        state.voiceParticipants[voice.channelId] ?? {},
      ),
      users: state.users,
    }
  })

  const snapshot = useMemo(
    () =>
      buildVoiceOverlaySnapshot({
        channelId: voice.channelId,
        channelLabel: overlayInput.channelLabel,
        participants: overlayInput.participants,
        speakingUserIds: voice.speakingUserIds,
        users: overlayInput.users,
      }),
    [
      overlayInput.channelLabel,
      overlayInput.participants,
      overlayInput.users,
      voice.channelId,
      voice.speakingUserIds,
    ],
  )

  useEffect(() => {
    if (!desktop || os !== 'win32') return
    let cancelled = false
    void desktop.overlay.setSnapshot(snapshot).catch((error) => {
      if (!cancelled) console.error('[desktop-overlay] snapshot failed', error)
    })
    return () => {
      cancelled = true
    }
  }, [desktop, os, snapshot])

  useEffect(() => {
    if (!desktop || os !== 'win32') return
    return () => {
      void desktop.overlay.setSnapshot({
        active: false,
        channelId: null,
        channelLabel: null,
        participants: [],
      })
    }
  }, [desktop, os])

  return null
}
