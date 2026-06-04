import { useQuery } from '@tanstack/react-query'

import {
  fetchSyrnikeConfig,
  type SyrnikeFeatures,
} from '#/features/api/config-api'
import { config } from '#/lib/config'
import { queryKeys } from '#/lib/api/query-keys'

export function useSyrnikeConfig() {
  return useQuery({
    queryKey: queryKeys.api.root,
    queryFn: fetchSyrnikeConfig,
    staleTime: 60_000,
  })
}

/** Ключ hCaptcha: env или ответ `GET /`. */
export function resolveHcaptchaSiteKey(features?: SyrnikeFeatures) {
  if (config.hcaptchaSiteKey) return config.hcaptchaSiteKey
  if (features?.captcha?.enabled && features.captcha.key) {
    return features.captcha.key
  }
  return undefined
}

/** Captcha только если сервер явно включил (`features.captcha.enabled`). */
export function isCaptchaRequired(features?: SyrnikeFeatures) {
  if (features?.captcha !== undefined) {
    return Boolean(features.captcha.enabled && resolveHcaptchaSiteKey(features))
  }
  return Boolean(config.hcaptchaSiteKey)
}

/** Подтверждение email — только при `features.email === true`. */
export function isEmailVerificationEnabled(features?: SyrnikeFeatures) {
  return features?.email === true
}

export function isInviteOnlyRegistration(features?: SyrnikeFeatures) {
  return features?.invite_only === true
}
