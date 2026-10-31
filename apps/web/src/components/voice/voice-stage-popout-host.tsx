import { useEffect } from 'react'
import { useTranslations } from '@syrnike13/ui/i18n'
import { useVoiceStage } from '#/features/voice/voice-stage-context'
import { useSyncStore } from '@syrnike13/client/sync/sync-store'
import { useAuth } from '#/features/auth/auth-context'
import { getChannelLabel } from '@syrnike13/client/sync/channel-label'
import { VoiceStageView } from './voice-stage-view'

export function VoiceStagePopoutHost() {
  const tChat = useTranslations('chat')
  const voice = useVoiceStage()
  useEffect(() => voice.closeStagePopout, [voice.closeStagePopout])
  const auth = useAuth()
  const channel = useSyncStore((state) =>
    voice.popoutChannelId ? state.channels[voice.popoutChannelId] : undefined,
  )
  const users = useSyncStore((state) => state.users)
  if (!channel || !voice.popoutWindow || voice.popoutWindow.closed) return null
  return (
    <VoiceStageView
      channel={channel}
      title={getChannelLabel(channel, users, auth.user?._id, tChat)}
      chatOpen={false}
      showChatToggle={false}
      popoutSurface
    />
  )
}
