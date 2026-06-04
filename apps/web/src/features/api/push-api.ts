import type { WebPushSubscription } from '@syrnike13/api-types'

import { apiRequest } from '#/lib/api/client'

export async function subscribePush(
  token: string,
  subscription: WebPushSubscription,
) {
  return apiRequest<void>('/push/subscribe', {
    method: 'POST',
    token,
    body: subscription,
  })
}

export async function unsubscribePush(
  token: string,
  subscription: WebPushSubscription,
) {
  return apiRequest<void>('/push/unsubscribe', {
    method: 'POST',
    token,
    body: subscription,
  })
}
