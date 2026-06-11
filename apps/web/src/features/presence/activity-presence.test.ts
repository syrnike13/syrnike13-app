import { describe, expect, it, vi } from 'vitest'

import {
  ACTIVITY_THROTTLE_MS,
  createActivityPresenceController,
} from './activity-presence'

describe('createActivityPresenceController', () => {
  it('sends activity when the gateway is connected', () => {
    const sendActivity = vi.fn()
    const controller = createActivityPresenceController({ sendActivity })

    controller.updateSnapshot({ gatewayConnected: true })
    controller.markActive()

    expect(sendActivity).toHaveBeenCalledTimes(1)
  })

  it('does not send activity while the gateway is disconnected', () => {
    const sendActivity = vi.fn()
    const controller = createActivityPresenceController({ sendActivity })

    controller.updateSnapshot({ gatewayConnected: false })
    controller.markActive()

    expect(sendActivity).not.toHaveBeenCalled()
  })

  it('throttles noisy activity events', () => {
    let now = 0
    const sendActivity = vi.fn()
    const controller = createActivityPresenceController({
      sendActivity,
      now: () => now,
    })

    controller.updateSnapshot({ gatewayConnected: true })

    controller.recordThrottledActivity()
    now += ACTIVITY_THROTTLE_MS - 1
    controller.recordThrottledActivity()
    now += 1
    controller.recordThrottledActivity()

    expect(sendActivity).toHaveBeenCalledTimes(2)
  })

  it('marks activity when the tab becomes visible again', () => {
    const sendActivity = vi.fn()
    const controller = createActivityPresenceController({ sendActivity })

    controller.updateSnapshot({ gatewayConnected: true })
    controller.onTabVisible()

    expect(sendActivity).toHaveBeenCalledTimes(1)
  })
})
