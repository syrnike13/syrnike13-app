import type { ManualPresence, Presence, User } from '@syrnike13/api-types'
import type { Translator } from '@syrnike13/ui/i18n'

export type PresenceOption = {
  value: ManualPresence
  labelKey: string
  dotClass: string
}

export const PRESENCE_OPTIONS: PresenceOption[] = [
  { value: 'Online', labelKey: 'online', dotClass: 'bg-chart-3' },
  { value: 'Idle', labelKey: 'idle', dotClass: 'bg-chart-2' },
  { value: 'Focus', labelKey: 'focus', dotClass: 'bg-chart-5' },
  { value: 'Busy', labelKey: 'busy', dotClass: 'bg-destructive' },
  { value: 'Invisible', labelKey: 'invisible', dotClass: 'bg-muted-foreground' },
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

export function presenceModeLabel(presence: Presence, t: Translator) {
  return t(PRESENCE_DISPLAY[presence]?.labelKey ?? 'online')
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
export function userStatusSubtitle(user: User | null | undefined, t: Translator) {
  if (!user) return ''

  const custom = user.status?.text?.trim()
  if (custom) return custom

  return presenceModeLabel(getUserPresence(user), t)
}

/** Для списков друзей/участников: офлайн или статус. */
export function presenceLabel(user: User | null | undefined, t: Translator) {
  if (!user) return ''
  if (!isUserOnline(user)) return t('offline').toLowerCase()

  const custom = user.status?.text?.trim()
  if (custom) return custom

  return presenceModeLabel(getUserPresence(user), t).toLowerCase()
}

export function presenceDotTitle(user: User | null | undefined, t: Translator) {
  if (!user) return ''
  if (!isUserOnline(user) && getUserPresence(user) !== 'Invisible') {
    return t('offline')
  }
  return presenceModeLabel(getUserPresence(user), t)
}
