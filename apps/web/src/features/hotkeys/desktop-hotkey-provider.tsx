import { useEffect, useRef, type ReactNode } from 'react'
import { useNavigate, useRouter } from '@tanstack/react-router'
import type { HotkeyActivationEvent } from '@syrnike13/platform'

import { usePlatform } from '#/platform/use-platform'
import { useVoice } from '#/features/voice/voice-context'

export function DesktopHotkeyProvider({ children }: { children: ReactNode }) {
  const { desktop } = usePlatform()
  const voice = useVoice()
  const navigate = useNavigate()
  const router = useRouter()
  const pushToTalkChangedMicRef = useRef(false)
  const pushToMuteChangedMicRef = useRef(false)

  useEffect(() => {
    if (!desktop) return

    return desktop.hotkeys.onPressed((event) => {
      runHotkeyAction(event, {
        voice,
        pushToTalkChangedMicRef,
        pushToMuteChangedMicRef,
        navigateBack: () => router.history.go(-1),
        navigateForward: () => router.history.go(1),
        navigateToVoice: () => {
          if (!voice.channelId) return
          void navigate({
            to: '/app/c/$channelId',
            params: { channelId: voice.channelId },
            search: { m: undefined },
          })
        },
      })
    })
  }, [desktop, navigate, router, voice])

  return children
}

function runHotkeyAction(
  event: HotkeyActivationEvent,
  context: {
    voice: ReturnType<typeof useVoice>
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
      context.voice.toggleMic()
      break
    case 'toggle-deafen':
      if (event.phase === 'released') break
      context.voice.toggleDeafen()
      break
    case 'toggle-camera':
      if (event.phase === 'released') break
      context.voice.toggleCamera()
      break
    case 'toggle-screen-share':
      if (event.phase === 'released') break
      context.voice.toggleScreenShare()
      break
    case 'return-to-voice':
      if (event.phase === 'released') break
      context.navigateToVoice()
      break
    case 'disconnect-voice':
      if (event.phase === 'released') break
      context.voice.leave()
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
        context.pushToTalkChangedMicRef.current = !context.voice.micEnabled
        if (context.pushToTalkChangedMicRef.current) context.voice.toggleMic()
      } else if (context.pushToTalkChangedMicRef.current) {
        context.voice.toggleMic()
        context.pushToTalkChangedMicRef.current = false
      }
      break
    case 'push-to-mute':
      if (event.phase === 'pressed') {
        context.pushToMuteChangedMicRef.current = context.voice.micEnabled
        if (context.pushToMuteChangedMicRef.current) context.voice.toggleMic()
      } else if (context.pushToMuteChangedMicRef.current) {
        context.voice.toggleMic()
        context.pushToMuteChangedMicRef.current = false
      }
      break
    case 'priority-push-to-talk':
    case 'toggle-vad':
      break
  }
}
