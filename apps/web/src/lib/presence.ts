import type { Presence, User } from '@syrnike13/api-types'

export type PresenceOption = {
  value: Presence
  label: string
  dotClass: string
}

export const PRESENCE_OPTIONS: PresenceOption[] = [
  { value: 'Online', label: 'В сети', dotClass: 'bg-chart-3' },
  { value: 'Idle', label: 'Не активен', dotClass: 'bg-amber-400' },
  { value: 'Focus', label: 'В фокусе', dotClass: 'bg-violet-500' },
  { value: 'Busy', label: 'Не беспокоить', dotClass: 'bg-red-500' },
  { value: 'Invisible', label: 'Невидимый', dotClass: 'bg-muted-foreground' },
]

export function isUserOnline(user?: User | null) {
  return Boolean(user?.online)
}

export function getUserPresence(user?: User | null): Presence {
  return user?.status?.presence ?? 'Online'
}

export function presenceModeLabel(presence: Presence) {
  return (
    PRESENCE_OPTIONS.find((option) => option.value === presence)?.label ??
    'В сети'
  )
}

export function presenceDotClass(user?: User | null) {
  if (!user) return 'bg-muted-foreground'

  const presence = getUserPresence(user)
  if (presence === 'Invisible') {
    return 'bg-muted-foreground'
  }

  if (!isUserOnline(user)) {
    return 'bg-muted-foreground'
  }

  return (
    PRESENCE_OPTIONS.find((option) => option.value === presence)?.dotClass ??
    'bg-muted-foreground'
  )
}

/** Подпись под именем: кастомный статус или режим присутствия. */
export function userStatusSubtitle(user?: User | null) {
  if (!user) return ''

  const custom = user.status?.text?.trim()
  if (custom) return custom

  return presenceModeLabel(getUserPresence(user))
}

/** Для списков друзей/участников: офлайн или статус. */
export function presenceLabel(user?: User | null) {
  if (!user) return ''
  if (!isUserOnline(user)) return 'не в сети'

  const custom = user.status?.text?.trim()
  if (custom) return custom

  return presenceModeLabel(getUserPresence(user)).toLowerCase()
}

export function presenceDotTitle(user?: User | null) {
  if (!user) return ''
  if (!isUserOnline(user) && getUserPresence(user) !== 'Invisible') {
    return 'Не в сети'
  }
  return presenceModeLabel(getUserPresence(user))
}
