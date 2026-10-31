import { syncStore } from '@syrnike13/client/sync/sync-store'
import {
  GatewayVoiceAuthorityAdapter,
  VoiceDirector,
  type VoiceGatewayTransport,
} from '@syrnike13/platform'

import { API_URL } from '../config'
import { eventsGateway } from '../data/gateway'
import { LiveKitEngineAdapter } from './livekit-engine'

const FALLBACK_VOICE_NODE = 'worldwide'

/** Same node choice as web: the first LiveKit node advertised by `GET /`. */
async function resolveVoiceNode() {
  try {
    const response = await fetch(`${API_URL}/`)
    const root = (await response.json()) as {
      features?: { livekit?: { nodes?: { name?: string }[] } }
    }
    return root.features?.livekit?.nodes?.[0]?.name || FALLBACK_VOICE_NODE
  } catch {
    return FALLBACK_VOICE_NODE
  }
}

function randomId() {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
}

const voiceTransport: VoiceGatewayTransport = {
  sendReliable: (message, key) => eventsGateway.sendReliable(message, key),
  subscribeEvents: (listener) => eventsGateway.subscribeEvents(listener),
  subscribeState: (listener) =>
    eventsGateway.subscribeState((state) =>
      listener(state === 'connected' ? 'connected' : 'unavailable'),
    ),
}

export function createVoiceDirector(currentUserId: string) {
  const authority = new GatewayVoiceAuthorityAdapter({
    transport: voiceTransport,
    async resolveJoinMetadata(request) {
      const channel = syncStore.getState().channels[request.channelId]
      const recipients =
        channel && (channel.channel_type === 'DirectMessage' || channel.channel_type === 'Group')
          ? channel.recipients.filter((userId) => userId !== currentUserId)
          : undefined
      return { node: await resolveVoiceNode(), recipients }
    },
  })
  const engine = new LiveKitEngineAdapter((source) =>
    eventsGateway.sendReliable({ type: 'VoiceMediaStopped', source }, `media-stopped:${source}`),
  )
  // LiveKit RN runs the same WebRTC stack as browsers, so the backend treats it as `web`.
  const director = new VoiceDirector({
    authority,
    engine,
    rtcEngine: 'web',
    clientInstanceId: `android-${randomId()}`,
  })
  return { director, engine }
}
