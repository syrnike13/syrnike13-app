import { toast } from 'sonner'

import { eventsGateway } from '#/features/events/gateway'

export const VOICE_REJOIN_DELAYS_MS = [2_000, 5_000, 10_000] as const

export type VoiceRejoinAttempt = (channelId: string) => Promise<boolean>

export type VoiceRejoinControllerOptions = {
  attemptRejoin: VoiceRejoinAttempt
  onGiveUp: () => void
  isGatewayConnected?: () => boolean
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
  const now = options.now ?? (() => Date.now())
  const scheduleTimeout = options.scheduleTimeout ?? setTimeout
  const clearTimeoutFn = options.clearTimeoutFn ?? clearTimeout
  const isGatewayConnected =
    options.isGatewayConnected ?? (() => eventsGateway.state === 'connected')

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

  const schedule = () => {
    const targetChannelId = channelId
    if (!targetChannelId) return
    if (timer !== undefined) return

    if (attempt >= VOICE_REJOIN_DELAYS_MS.length) {
      cancel()
      toast.error('Не удалось восстановить голос')
      options.onGiveUp()
      return
    }

    const delay = VOICE_REJOIN_DELAYS_MS[attempt]
    timer = scheduleTimeout(() => {
      timer = undefined

      if (!isGatewayConnected()) {
        schedule()
        return
      }

      void options.attemptRejoin(targetChannelId).then((ok) => {
        if (ok) {
          cancel()
          return
        }
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
