import {
  GatewayVoiceAuthorityAdapter,
  type VoiceGatewayTransport,
} from '@syrnike13/platform'
import { Effect } from 'effect'

import { eventsGateway } from '#/features/events/gateway'
import { syncStore } from '#/features/sync/sync-store'
import { resolveVoiceNodeNameEffect } from '#/features/voice/voice-node'

const webVoiceGatewayTransport: VoiceGatewayTransport = {
  sendReliable(message, key) {
    eventsGateway.sendReliable(message, key)
  },
  subscribeEvents(listener) {
    return eventsGateway.subscribeEvents(listener)
  },
  subscribeState(listener) {
    return eventsGateway.subscribeState((state) => {
      listener(state === 'connected' ? 'connected' : 'unavailable')
    })
  },
}

export function createWebVoiceAuthorityAdapter(getCurrentUserId: () => string | null) {
  return new GatewayVoiceAuthorityAdapter({
    transport: webVoiceGatewayTransport,
    async resolveJoinMetadata(request) {
      const channel = syncStore.getState().channels[request.channelId]
      const currentUserId = getCurrentUserId()
      const recipients =
        currentUserId &&
        channel &&
        (channel.channel_type === 'DirectMessage' ||
          channel.channel_type === 'Group')
          ? channel.recipients.filter((userId) => userId !== currentUserId)
          : undefined
      return {
        node: await Effect.runPromise(resolveVoiceNodeNameEffect),
        recipients,
      }
    },
  })
}

export { webVoiceGatewayTransport }
