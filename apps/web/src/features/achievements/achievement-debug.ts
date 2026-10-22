import type { UserBadge } from '@syrnike13/api-types'
import type { Translator } from '@syrnike13/ui/i18n'

import { uiFeatureFlags } from '#/lib/ui-feature-flags'

import {
  achievementFromBadge,
  achievementQueue,
  type AchievementUnlock,
} from './achievement-queue'

const AUTOPLAY_STORAGE_KEY = 'syrnike.debug.achievements.autoplay'

export type DebugAchievementCopy = {
  testName: string
  testDescription: string
  secondName: string
  longName: string
  longDescription: string
}

let debugSequence = 0

export function debugAchievementCopy(t: Translator): DebugAchievementCopy {
  return {
    testName: t('copy.testName'),
    testDescription: t('copy.testDescription'),
    secondName: t('copy.secondName'),
    longName: t('copy.longName'),
    longDescription: t('copy.longDescription'),
  }
}

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

export function demoAchievement(copy: DebugAchievementCopy) {
  return debugUnlock(copy.testName, copy.testDescription)
}

/** Показывает тестовое уведомление без запроса к серверу. */
export function showDebugAchievement(
  copy: DebugAchievementCopy,
  unlock: AchievementUnlock = demoAchievement(copy),
) {
  achievementQueue.enqueue([unlock])
}

/** Показывает очередь из бейджей пользователя (или тестовых, если их нет). */
export function showDebugAchievementQueue(
  copy: DebugAchievementCopy,
  badges: readonly UserBadge[] = [],
) {
  const fromBadges = badges.map((badge) => ({
    ...achievementFromBadge(badge),
    id: `debug:${badge._id}:${++debugSequence}`,
    badgeId: null,
  }))
  achievementQueue.enqueue(
    fromBadges.length > 0
      ? fromBadges
      : [
          demoAchievement(copy),
          debugUnlock(copy.secondName, null),
          debugUnlock(copy.longName, copy.longDescription),
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
