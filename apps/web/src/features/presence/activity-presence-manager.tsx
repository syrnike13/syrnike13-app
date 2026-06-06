import type { Presence } from '@syrnike13/api-types'
import { useQueryClient } from '@tanstack/react-query'
import { useEffect, useRef } from 'react'

import { updateCurrentUser } from '#/features/api/users-api'
import { useAuth } from '#/features/auth/auth-context'
import { syncStore } from '#/features/sync/sync-store'
import { queryKeys } from '#/lib/api/query-keys'

import {
  createActivityPresenceController,
  IDLE_CHECK_INTERVAL_MS,
} from './activity-presence'

export function ActivityPresenceManager() {
  const auth = useAuth()
  const queryClient = useQueryClient()
  const snapshotRef = useRef({
    token: auth.session?.token,
    user: auth.user,
    gatewayConnected: auth.gatewayState === 'connected',
  })

  const controllerRef = useRef(
    createActivityPresenceController({
      applyPresence: async (presence: Presence, user, token) => {
        const updated = await updateCurrentUser(token, {
          status: {
            presence,
            text: user.status?.text ?? null,
          },
        })
        syncStore.upsertUser(updated)
        queryClient.setQueryData(queryKeys.auth.session, updated)
      },
    }),
  )

  snapshotRef.current = {
    token: auth.session?.token,
    user: auth.user,
    gatewayConnected: auth.gatewayState === 'connected',
  }

  useEffect(() => {
    controllerRef.current.updateSnapshot(snapshotRef.current)
  }, [auth.gatewayState, auth.session?.token, auth.user])

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

    const interval = window.setInterval(
      () => controller.evaluateIdle(),
      IDLE_CHECK_INTERVAL_MS,
    )

    return () => {
      window.removeEventListener('pointerdown', onActivity)
      window.removeEventListener('keydown', onActivity)
      window.removeEventListener('wheel', onActivity)
      window.removeEventListener('touchstart', onActivity)
      document.removeEventListener('visibilitychange', onVisibilityChange)
      window.clearInterval(interval)
    }
  }, [auth.user])

  return null
}
