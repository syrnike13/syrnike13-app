import { createFileRoute } from '@tanstack/react-router'

import { VoiceRtcDebugView } from '#/components/voice/voice-rtc-debug-view'

export const Route = createFileRoute('/app/voice-debug')({
  component: VoiceRtcDebugRoute,
})

function VoiceRtcDebugRoute() {
  return <VoiceRtcDebugView />
}
