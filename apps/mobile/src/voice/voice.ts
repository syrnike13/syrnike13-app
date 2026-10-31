import { GatewayVoiceAuthorityAdapter, VoiceDirector } from '@syrnike13/platform'

import { API_URL } from '../config'
import type { Gateway } from '../gateway/gateway'
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

export function createVoiceDirector(gateway: Gateway) {
  const authority = new GatewayVoiceAuthorityAdapter({
    transport: gateway,
    async resolveJoinMetadata() {
      return { node: await resolveVoiceNode() }
    },
  })
  const engine = new LiveKitEngineAdapter((source) =>
    gateway.sendReliable({ type: 'VoiceMediaStopped', source }, `media-stopped:${source}`),
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
