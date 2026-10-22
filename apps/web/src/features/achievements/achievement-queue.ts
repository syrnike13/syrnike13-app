import type { UserBadge } from '@syrnike13/api-types'
import { useSyncExternalStore } from 'react'

import { badgeIconUrl } from '#/lib/media'

export type AchievementUnlock = {
  /** Уникальный ключ показа. */
  id: string
  /** Бейдж на сервере; `null` у отладочных показов, их не нужно подтверждать. */
  badgeId: string | null
  name: string
  description: string | null
  iconUrl: string | null
}

export type AchievementQueueState = {
  current: AchievementUnlock | null
  pending: AchievementUnlock[]
}

export function achievementFromBadge(badge: UserBadge): AchievementUnlock {
  return {
    id: `badge:${badge._id}`,
    badgeId: badge._id,
    name: badge.name,
    description: badge.description ?? null,
    iconUrl: badgeIconUrl(badge.icon),
  }
}

/** Очередь уведомлений: показывает по одному, повторный бейдж не дублирует. */
export function createAchievementQueue() {
  let state: AchievementQueueState = { current: null, pending: [] }
  const listeners = new Set<() => void>()

  function emit(next: AchievementQueueState) {
    state = next
    for (const listener of listeners) listener()
  }

  function isQueued(id: string) {
    return state.current?.id === id || state.pending.some((item) => item.id === id)
  }

  return {
    getState: () => state,
    subscribe(listener: () => void) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    enqueue(unlocks: readonly AchievementUnlock[]) {
      const fresh: AchievementUnlock[] = []
      for (const unlock of unlocks) {
        if (isQueued(unlock.id) || fresh.some((item) => item.id === unlock.id)) {
          continue
        }
        fresh.push(unlock)
      }
      if (fresh.length === 0) return

      const pending = [...state.pending, ...fresh]
      emit(
        state.current
          ? { current: state.current, pending }
          : { current: pending[0] ?? null, pending: pending.slice(1) },
      )
    },
    /** Убирает текущее уведомление и показывает следующее. */
    advance() {
      emit({
        current: state.pending[0] ?? null,
        pending: state.pending.slice(1),
      })
    },
    clear() {
      emit({ current: null, pending: [] })
    },
  }
}

export const achievementQueue = createAchievementQueue()

export function useCurrentAchievement() {
  return useSyncExternalStore(
    achievementQueue.subscribe,
    () => achievementQueue.getState().current,
    () => null,
  )
}
