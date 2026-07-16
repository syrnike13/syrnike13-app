import type { ManualPresence, Presence, User } from '@syrnike13/api-types'

export type PresenceOption = {
  value: ManualPresence
  label: string
  dotClass: string
}

export const PRESENCE_OPTIONS: PresenceOption[] = [
  { value: 'Online', label: 'В сети', dotClass: 'bg-chart-3' },
  { value: 'Idle', label: 'Не активен', dotClass: 'bg-chart-2' },
  { value: 'Focus', label: 'В фокусе', dotClass: 'bg-chart-5' },
  { value: 'Busy', label: 'Не беспокоить', dotClass: 'bg-destructive' },
  { value: 'Invisible', label: 'Невидимый', dotClass: 'bg-muted-foreground' },
]

export const PRESENCE_DISPLAY: Record<Presence, PresenceOption> = {
  Online: PRESENCE_OPTIONS[0],
  Idle: PRESENCE_OPTIONS[1],
  Focus: PRESENCE_OPTIONS[2],
  Busy: PRESENCE_OPTIONS[3],
  Invisible: PRESENCE_OPTIONS[4],
  SystemIdle: PRESENCE_OPTIONS[1],
  SystemWebOnline: PRESENCE_OPTIONS[0],
  SystemMobileOnline: PRESENCE_OPTIONS[0],
}

export function isUserOnline(user?: User | null) {
  return Boolean(user?.online)
}

export function getUserPresence(user?: User | null): Presence {
  return user?.status?.presence ?? 'Online'
}

export function presenceModeLabel(presence: Presence) {
  return PRESENCE_DISPLAY[presence]?.label ?? 'В сети'
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

  return PRESENCE_DISPLAY[presence]?.dotClass ?? 'bg-muted-foreground'
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
