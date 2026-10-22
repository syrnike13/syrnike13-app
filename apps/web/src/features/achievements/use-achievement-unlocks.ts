import { Effect } from 'effect'
import { useEffect } from 'react'
import { useTranslations } from '@syrnike13/ui/i18n'

import { useAuth } from '#/features/auth/auth-context'
import { eventsGateway } from '#/features/events/gateway'

import {
  debugAchievementCopy,
  readAchievementAutoplay,
  showDebugAchievement,
} from './achievement-debug'
import { achievementFromBadge, achievementQueue } from './achievement-queue'
import { acknowledgeBadgesEffect, fetchUnseenBadgesEffect } from './achievements-api'

const AUTOPLAY_DELAY_MS = 1500

/**
 * Собирает новые бейджи пользователя в очередь уведомлений:
 * непоказанные при входе и переподключении, новые — из события `UserBadgeUnlock`.
 */
export function useAchievementUnlocks() {
  const token = useAuth().session?.token
  const t = useTranslations('achievements.debug')

  useEffect(() => {
    if (!token) return
    let disposed = false

    const loadUnseen = () => {
      Effect.runPromise(fetchUnseenBadgesEffect(token))
        .then((badges) => {
          if (!disposed) achievementQueue.enqueue(badges.map(achievementFromBadge))
        })
        .catch(() => {
          // Покажем при следующем входе или переподключении.
        })
    }

    loadUnseen()
    const unsubscribe = eventsGateway.subscribeServerEvents((event) => {
      if (event.type === 'Ready') loadUnseen()
      if (event.type === 'UserBadgeUnlock') {
        achievementQueue.enqueue([achievementFromBadge(event.badge)])
      }
    })

    return () => {
      disposed = true
      unsubscribe()
      achievementQueue.clear()
    }
  }, [token])

  useEffect(() => {
    if (!readAchievementAutoplay()) return
    const timer = window.setTimeout(
      () => showDebugAchievement(debugAchievementCopy(t)),
      AUTOPLAY_DELAY_MS,
    )
    return () => window.clearTimeout(timer)
  }, [t])
}

/** Отмечает бейдж показанным, чтобы уведомление не повторилось. */
export function acknowledgeAchievement(token: string, badgeId: string) {
  Effect.runPromise(acknowledgeBadgesEffect(token, [badgeId])).catch(() => {
    // Не удалось — бейдж покажется ещё раз при следующем входе.
  })
}
