import type { Translator } from '@syrnike13/ui/i18n'

import { ActivityRequestError } from './activity-store'

const DESCRIBED_ERRORS = new Set([
  'not_in_voice_channel',
  'missing_permission',
  'unknown_application',
  'already_running',
  'full',
  'not_allowed',
  'rate_limited',
  'disconnected',
  'timeout',
])

/** Localized error for a failed lifecycle request (`activities` namespace). */
export function activityErrorMessage(error: unknown, t: Translator) {
  const code = error instanceof ActivityRequestError ? error.code : 'internal'
  return DESCRIBED_ERRORS.has(code)
    ? t(`errors.${code}`)
    : t('errors.generic')
}
