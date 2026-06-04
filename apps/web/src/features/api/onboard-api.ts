import type { User } from '@syrnike13/api-types'

import { apiRequest } from '#/lib/api/client'

export type OnboardHelloResponse = {
  onboarding: boolean
}

export async function fetchOnboardHello(token: string) {
  return apiRequest<OnboardHelloResponse>('/onboard/hello', { token })
}

export async function completeOnboarding(token: string, username: string) {
  return apiRequest<User>('/onboard/complete', {
    method: 'POST',
    token,
    body: { username },
  })
}
