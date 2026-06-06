import type { Presence, User } from '@syrnike13/api-types'

export const IDLE_AFTER_MS = 5 * 60 * 1000
export const HIDDEN_IDLE_AFTER_MS = 60 * 1000
export const PRESENCE_DEBOUNCE_MS = 2_000
export const ACTIVITY_THROTTLE_MS = 1_000
export const IDLE_CHECK_INTERVAL_MS = 30_000

const PRESENCE_AUTO_IDLE_FROM = new Set<Presence>(['Online'])

export type ActivityPresenceSnapshot = {
  token: string | undefined
  user: User | undefined
  gatewayConnected: boolean
}

export type ApplyPresence = (
  presence: Presence,
  user: User,
  token: string,
) => Promise<void>

export function getUserPresenceValue(user: User): Presence {
  return user.status?.presence ?? 'Online'
}

export function createActivityPresenceController(options: {
  applyPresence: ApplyPresence
  now?: () => number
}) {
  const now = options.now ?? (() => Date.now())

  let autoIdle = false
  let lastActivityAt = now()
  let hiddenSince: number | null = null
  let lastPresenceChangeAt = 0
  let lastActivityEventAt = 0
  let presenceInFlight = false
  let snapshot: ActivityPresenceSnapshot = {
    token: undefined,
    user: undefined,
    gatewayConnected: false,
  }

  const syncManualPresence = (user: User | undefined) => {
    if (!user) return
    const presence = getUserPresenceValue(user)
    if (presence !== 'Idle' && presence !== 'Online') {
      autoIdle = false
    }
  }

  const applyPresenceIfNeeded = async (presence: Presence) => {
    const { token, user } = snapshot
    if (!token || !user) return
    if (presenceInFlight) return

    const wakingFromAutoIdle = presence === 'Online' && autoIdle
    if (
      !wakingFromAutoIdle &&
      now() - lastPresenceChangeAt < PRESENCE_DEBOUNCE_MS
    ) {
      return
    }

    const current = getUserPresenceValue(user)
    if (current === presence) {
      autoIdle = presence === 'Idle'
      return
    }

    if (presence === 'Idle' && !PRESENCE_AUTO_IDLE_FROM.has(current)) {
      return
    }

    if (presence === 'Online' && !autoIdle) {
      return
    }

    presenceInFlight = true
    lastPresenceChangeAt = now()

    try {
      await options.applyPresence(presence, user, token)
      autoIdle = presence === 'Idle'
    } catch {
      // повторим на следующей проверке
    } finally {
      presenceInFlight = false
    }
  }

  return {
    updateSnapshot(next: ActivityPresenceSnapshot) {
      snapshot = next
      syncManualPresence(next.user)
    },
    markActive() {
      lastActivityAt = now()
      hiddenSince = null
      if (autoIdle) {
        void applyPresenceIfNeeded('Online')
      }
    },
    recordThrottledActivity() {
      const current = now()
      if (current - lastActivityEventAt < ACTIVITY_THROTTLE_MS) return
      lastActivityEventAt = current
      this.markActive()
    },
    onTabHidden() {
      hiddenSince = now()
    },
    onTabVisible() {
      this.markActive()
      this.evaluateIdle()
    },
    evaluateIdle() {
      if (!snapshot.gatewayConnected) return

      const user = snapshot.user
      if (!user) return

      const current = getUserPresenceValue(user)
      if (!PRESENCE_AUTO_IDLE_FROM.has(current)) {
        if (current !== 'Idle') {
          autoIdle = false
        }
        return
      }

      const currentTime = now()
      if (
        hiddenSince != null &&
        currentTime - hiddenSince >= HIDDEN_IDLE_AFTER_MS
      ) {
        void applyPresenceIfNeeded('Idle')
        return
      }

      if (currentTime - lastActivityAt >= IDLE_AFTER_MS) {
        void applyPresenceIfNeeded('Idle')
      }
    },
    isAutoIdle() {
      return autoIdle
    },
  }
}

export type ActivityPresenceController = ReturnType<
  typeof createActivityPresenceController
>
