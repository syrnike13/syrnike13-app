import { useNavigate } from '@tanstack/react-router'
import { useCallback } from 'react'

import { useAppRoutePrefix } from '#/features/navigation/route-prefix'
import { useVoice } from '#/features/voice/voice-context'

export function useWatchParticipantScreenShare() {
  const voice = useVoice()
  const navigate = useNavigate()
  const prefix = useAppRoutePrefix()

  return useCallback(
    async (channelId: string, userId: string) => {
      void navigate({
        to: `${prefix}/c/$channelId`,
        params: { channelId },
        search: { m: undefined },
      })
      await voice.watchParticipantScreenShare(channelId, userId)
    },
    [navigate, prefix, voice],
  )
}
