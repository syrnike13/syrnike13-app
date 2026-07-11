import { useEffect, type ReactNode } from 'react'
import { useNavigate, useRouter } from '@tanstack/react-router'
import type { HotkeyActivationEvent } from '@syrnike13/platform'

import { usePlatform } from '#/platform/use-platform'
import {
  useVoiceMedia,
  type VoiceMediaContextValue,
} from '#/features/voice/voice-media-context'
import {
  useVoiceSession,
  type VoiceSessionContextValue,
} from '#/features/voice/voice-session-context'

export function DesktopHotkeyProvider({ children }: { children: ReactNode }) {
  const { desktop } = usePlatform()
  const voiceSession = useVoiceSession()
  const voiceMedia = useVoiceMedia()
  const navigate = useNavigate()
  const router = useRouter()

  useEffect(() => {
    if (!desktop) return

    return desktop.hotkeys.onPressed((event) => {
      runHotkeyAction(event, {
        voiceSession,
        voiceMedia,
        navigateBack: () => router.history.go(-1),
        navigateForward: () => router.history.go(1),
        navigateToVoice: () => {
          if (!voiceSession.channelId) return
          void navigate({
            to: '/app/c/$channelId',
            params: { channelId: voiceSession.channelId },
            search: { m: undefined },
          })
        },
      })
    })
  }, [desktop, navigate, router, voiceMedia, voiceSession])

  return children
}

function runHotkeyAction(
  event: HotkeyActivationEvent,
  context: {
    voiceSession: VoiceSessionContextValue
    voiceMedia: VoiceMediaContextValue
    navigateBack: () => void
    navigateForward: () => void
    navigateToVoice: () => void
  },
) {
  switch (event.action) {
    case 'toggle-mic':
    case 'toggle-deafen':
    case 'toggle-camera':
    case 'disconnect-voice':
    case 'push-to-talk':
    case 'push-to-mute':
    case 'priority-push-to-talk':
    case 'toggle-vad':
      // Electron main owns voice intent and applies these even while the
      // renderer is reloading or hidden.
      break
    case 'toggle-screen-share':
      if (event.phase === 'released') break
      context.voiceMedia.toggleScreenShare()
      break
    case 'return-to-voice':
      if (event.phase === 'released') break
      context.navigateToVoice()
      break
    case 'navigate-back':
      if (event.phase === 'released') break
      context.navigateBack()
      break
    case 'navigate-forward':
      if (event.phase === 'released') break
      context.navigateForward()
      break
  }
}
