import { useEffect, useRef } from 'react'

import { useAuth } from '#/features/auth/auth-context'
import { eventsGateway } from '#/features/events/gateway'

import { createActivityPresenceController } from './activity-presence'

export function ActivityPresenceManager() {
  const auth = useAuth()
  const snapshotRef = useRef({
    gatewayConnected: auth.gatewayState === 'connected',
  })

  const controllerRef = useRef(
    createActivityPresenceController({
      sendActivity: () => eventsGateway.userActivity(),
    }),
  )

  snapshotRef.current = {
    gatewayConnected: auth.gatewayState === 'connected',
  }

  useEffect(() => {
    controllerRef.current.updateSnapshot(snapshotRef.current)
  }, [auth.gatewayState])

  useEffect(() => {
    if (!auth.user) return

    const controller = controllerRef.current

    const onVisibilityChange = () => {
      if (document.visibilityState === 'hidden') {
        controller.onTabHidden()
        return
      }
      controller.onTabVisible()
    }

    const onActivity = () => {
      controller.recordThrottledActivity()
    }

    window.addEventListener('pointerdown', onActivity)
    window.addEventListener('keydown', onActivity)
    window.addEventListener('wheel', onActivity, { passive: true })
    window.addEventListener('touchstart', onActivity, { passive: true })
    document.addEventListener('visibilitychange', onVisibilityChange)

    return () => {
      window.removeEventListener('pointerdown', onActivity)
      window.removeEventListener('keydown', onActivity)
      window.removeEventListener('wheel', onActivity)
      window.removeEventListener('touchstart', onActivity)
      document.removeEventListener('visibilitychange', onVisibilityChange)
    }
  }, [auth.user])

  return null
}
