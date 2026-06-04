import type { User } from '@syrnike13/api-types'

export function isUserOnline(user?: User | null) {
  return Boolean(user?.online)
}

export function presenceLabel(user?: User | null) {
  if (!user) return ''
  return isUserOnline(user) ? 'в сети' : 'не в сети'
}
