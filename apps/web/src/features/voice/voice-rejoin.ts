export const VOICE_REJOIN_DELAYS_MS = [500, 5_000, 10_000] as const
export const VOICE_REJOIN_STEADY_RETRY_MS = 15_000

export type VoiceRejoinAttempt = (channelId: string) => Promise<boolean>

export type VoiceRejoinControllerOptions = {
  attemptRejoin: VoiceRejoinAttempt
  onGiveUp: () => void
  isGatewayConnected: () => boolean
  shouldKeepTrying?: (channelId: string) => boolean
  now?: () => number
  scheduleTimeout?: typeof setTimeout
  clearTimeoutFn?: typeof clearTimeout
}

export type VoiceRejoinController = {
  cancel: () => void
  onUnexpectedDisconnect: (channelId: string) => void
  onGatewayConnected: () => void
  getPendingChannelId: () => string | null
  getAttempt: () => number
  hasScheduledTimer: () => boolean
}

export function createVoiceRejoinController(
  options: VoiceRejoinControllerOptions,
): VoiceRejoinController {
  const scheduleTimeout = options.scheduleTimeout ?? setTimeout
  const clearTimeoutFn = options.clearTimeoutFn ?? clearTimeout
  const isGatewayConnected = options.isGatewayConnected
  const shouldKeepTrying = options.shouldKeepTrying ?? (() => true)

  let attempt = 0
  let timer: ReturnType<typeof setTimeout> | undefined
  let channelId: string | null = null

  const cancel = () => {
    if (timer !== undefined) {
      clearTimeoutFn(timer)
      timer = undefined
    }
    attempt = 0
    channelId = null
  }

  const giveUp = () => {
    cancel()
    options.onGiveUp()
  }

  const nextDelay = () =>
    attempt < VOICE_REJOIN_DELAYS_MS.length
      ? VOICE_REJOIN_DELAYS_MS[attempt]
      : VOICE_REJOIN_STEADY_RETRY_MS

  const schedule = () => {
    const targetChannelId = channelId
    if (!targetChannelId) return
    if (timer !== undefined) return

    if (!shouldKeepTrying(targetChannelId)) {
      giveUp()
      return
    }

    const delay = nextDelay()
    timer = scheduleTimeout(() => {
      timer = undefined

      if (!shouldKeepTrying(targetChannelId)) {
        giveUp()
        return
      }

      if (!isGatewayConnected()) {
        schedule()
        return
      }

      void options
        .attemptRejoin(targetChannelId)
        .then((ok) => {
          if (ok) {
            cancel()
            return
          }
          if (!channelId) return
          attempt += 1
          schedule()
        })
        .catch(() => {
          if (!channelId) return
          attempt += 1
          schedule()
        })
    }, delay)
  }

  return {
    cancel,
    onUnexpectedDisconnect(targetChannelId) {
      channelId = targetChannelId
      attempt = 0
      schedule()
    },
    onGatewayConnected() {
      if (!channelId) return
      schedule()
    },
    getPendingChannelId: () => channelId,
    getAttempt: () => attempt,
    hasScheduledTimer: () => timer !== undefined,
  }
}
