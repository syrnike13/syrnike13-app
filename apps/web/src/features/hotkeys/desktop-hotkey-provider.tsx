import { useEffect, useRef, type ReactNode } from 'react'
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
  const pushToTalkChangedMicRef = useRef(false)
  const pushToMuteChangedMicRef = useRef(false)

  useEffect(() => {
    if (!desktop) return

    return desktop.hotkeys.onPressed((event) => {
      runHotkeyAction(event, {
        voiceSession,
        voiceMedia,
        pushToTalkChangedMicRef,
        pushToMuteChangedMicRef,
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
    pushToTalkChangedMicRef: { current: boolean }
    pushToMuteChangedMicRef: { current: boolean }
    navigateBack: () => void
    navigateForward: () => void
    navigateToVoice: () => void
  },
) {
  switch (event.action) {
    case 'toggle-mic':
      if (event.phase === 'released') break
      context.voiceSession.toggleMic()
      break
    case 'toggle-deafen':
      if (event.phase === 'released') break
      context.voiceSession.toggleDeafen()
      break
    case 'toggle-camera':
      if (event.phase === 'released') break
      context.voiceMedia.toggleCamera()
      break
    case 'toggle-screen-share':
      if (event.phase === 'released') break
      context.voiceMedia.toggleScreenShare()
      break
    case 'return-to-voice':
      if (event.phase === 'released') break
      context.navigateToVoice()
      break
    case 'disconnect-voice':
      if (event.phase === 'released') break
      context.voiceSession.leave()
      break
    case 'navigate-back':
      if (event.phase === 'released') break
      context.navigateBack()
      break
    case 'navigate-forward':
      if (event.phase === 'released') break
      context.navigateForward()
      break
    case 'push-to-talk':
      if (event.phase === 'pressed') {
        context.pushToTalkChangedMicRef.current = !context.voiceSession.micEnabled
        if (context.pushToTalkChangedMicRef.current) {
          context.voiceSession.toggleMic()
        }
      } else if (context.pushToTalkChangedMicRef.current) {
        context.voiceSession.toggleMic()
        context.pushToTalkChangedMicRef.current = false
      }
      break
    case 'push-to-mute':
      if (event.phase === 'pressed') {
        context.pushToMuteChangedMicRef.current = context.voiceSession.micEnabled
        if (context.pushToMuteChangedMicRef.current) {
          context.voiceSession.toggleMic()
        }
      } else if (context.pushToMuteChangedMicRef.current) {
        context.voiceSession.toggleMic()
        context.pushToMuteChangedMicRef.current = false
      }
      break
    case 'priority-push-to-talk':
    case 'toggle-vad':
      break
  }
}
