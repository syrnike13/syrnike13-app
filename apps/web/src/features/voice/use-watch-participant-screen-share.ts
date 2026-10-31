import { useNavigate } from '@tanstack/react-router'
import { useCallback } from 'react'

import { useVoiceStage } from '#/features/voice/voice-stage-context'

export function useWatchParticipantScreenShare() {
  const voice = useVoiceStage()
  const navigate = useNavigate()

  return useCallback(
    async (channelId: string, userId: string) => {
      void navigate({
        to: '/c/$channelId',
        params: { channelId },
        search: { m: undefined },
      })
      await voice.watchParticipantScreenShare(channelId, userId)
    },
    [navigate, voice],
  )
}
