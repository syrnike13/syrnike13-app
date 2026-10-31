import type { User } from '@syrnike13/api-types'
import type { AvatarStatus } from '@syrnike13/ui-native/primitives/avatar'

/** The presence dot for a user: offline wins, then the chosen presence. */
export function userStatus(user: User | undefined): AvatarStatus | undefined {
  if (!user) return undefined
  if (!user.online) return 'offline'
  switch (user.status?.presence) {
    // The web's Focus has no Discord dot; it reads as Do Not Disturb.
    case 'Busy':
    case 'Focus':
      return 'dnd'
    case 'Idle':
      return 'idle'
    case 'Invisible':
      return 'offline'
    default:
      return 'online'
  }
}

export function displayName(user: User | undefined) {
  return user?.display_name ?? user?.username ?? ''
}
