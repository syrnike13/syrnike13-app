import { apiRequest } from '#/lib/api/client'

export type SyrnikeFeatures = {
  captcha?: {
    enabled?: boolean
    key?: string
  }
  email?: boolean
  invite_only?: boolean
  livekit?: { enabled?: boolean; nodes?: Record<string, unknown> }
}

export type SyrnikeConfig = {
  syrnike?: string
  ws?: string
  app?: string
  vapid?: string
  features?: SyrnikeFeatures
}

export async function fetchSyrnikeConfig() {
  return apiRequest<SyrnikeConfig>('/')
}
