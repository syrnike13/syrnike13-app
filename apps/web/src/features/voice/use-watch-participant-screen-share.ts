import { useNavigate } from '@tanstack/react-router'
import { useCallback } from 'react'

import { useVoice } from '#/features/voice/voice-context'

export function useWatchParticipantScreenShare() {
  const voice = useVoice()
  const navigate = useNavigate()

  return useCallback(
    async (channelId: string, userId: string) => {
      void navigate({
        to: '/app/c/$channelId',
        params: { channelId },
        search: { m: undefined },
      })
      await voice.watchParticipantScreenShare(channelId, userId)
    },
    [navigate, voice],
  )
}
