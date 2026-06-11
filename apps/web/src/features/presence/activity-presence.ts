export const ACTIVITY_THROTTLE_MS = 1_000

export type ActivityPresenceSnapshot = {
  gatewayConnected: boolean
}

export type SendActivity = () => void

export function createActivityPresenceController(options: {
  sendActivity: SendActivity
  now?: () => number
}) {
  const now = options.now ?? (() => Date.now())

  let lastActivityEventAt = -ACTIVITY_THROTTLE_MS
  let snapshot: ActivityPresenceSnapshot = {
    gatewayConnected: false,
  }

  const sendActivityIfConnected = () => {
    if (!snapshot.gatewayConnected) return
    options.sendActivity()
  }

  return {
    updateSnapshot(next: ActivityPresenceSnapshot) {
      snapshot = next
    },
    markActive() {
      sendActivityIfConnected()
    },
    recordThrottledActivity() {
      const current = now()
      if (current - lastActivityEventAt < ACTIVITY_THROTTLE_MS) return
      lastActivityEventAt = current
      this.markActive()
    },
    onTabHidden() {},
    onTabVisible() {
      this.markActive()
    },
  }
}

export type ActivityPresenceController = ReturnType<
  typeof createActivityPresenceController
>
