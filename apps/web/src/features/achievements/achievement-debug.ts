import type { UserBadge } from '@syrnike13/api-types'

import { uiFeatureFlags } from '#/lib/ui-feature-flags'

import {
  achievementFromBadge,
  achievementQueue,
  type AchievementUnlock,
} from './achievement-queue'

const AUTOPLAY_STORAGE_KEY = 'syrnike.debug.achievements.autoplay'

let debugSequence = 0

function debugUnlock(
  name: string,
  description: string | null,
  iconUrl: string | null = null,
): AchievementUnlock {
  debugSequence += 1
  return {
    id: `debug:${debugSequence}`,
    badgeId: null,
    name,
    description,
    iconUrl,
  }
}

export function demoAchievement() {
  return debugUnlock(
    'Тестовое достижение',
    'Так выглядит получение нового бейджа.',
  )
}

/** Показывает тестовое уведомление без запроса к серверу. */
export function showDebugAchievement(unlock: AchievementUnlock = demoAchievement()) {
  achievementQueue.enqueue([unlock])
}

/** Показывает очередь из бейджей пользователя (или тестовых, если их нет). */
export function showDebugAchievementQueue(badges: readonly UserBadge[] = []) {
  const fromBadges = badges.map((badge) => ({
    ...achievementFromBadge(badge),
    id: `debug:${badge._id}:${++debugSequence}`,
    badgeId: null,
  }))
  achievementQueue.enqueue(
    fromBadges.length > 0
      ? fromBadges
      : [
          demoAchievement(),
          debugUnlock('Второе достижение', null),
          debugUnlock(
            'Очень длинное название достижения, которое не помещается',
            'Длинное описание проверяет перенос строк и обрезку текста в уведомлении.',
          ),
        ],
  )
}

export function readAchievementAutoplay() {
  if (!uiFeatureFlags.achievementDebug) return false
  try {
    return window.localStorage.getItem(AUTOPLAY_STORAGE_KEY) === '1'
  } catch {
    return false
  }
}

export function writeAchievementAutoplay(enabled: boolean) {
  try {
    if (enabled) window.localStorage.setItem(AUTOPLAY_STORAGE_KEY, '1')
    else window.localStorage.removeItem(AUTOPLAY_STORAGE_KEY)
  } catch {
    // Хранилище недоступно: настройка просто не сохранится.
  }
}
