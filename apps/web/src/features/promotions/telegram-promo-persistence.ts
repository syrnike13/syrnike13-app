import { Effect } from 'effect'

import {
  loadDesktopLocalSettingsEffect,
  updateDesktopLocalSettingsEffect,
} from '#/features/settings/desktop-local-settings-client'
import { getSyrnikeDesktop } from '#/platform/runtime'

export const TELEGRAM_PROMO_DISMISSED_STORAGE_KEY =
  'syrnike13.telegramPromoDismissed'

function browserStorageKey(userId: string) {
  return `${TELEGRAM_PROMO_DISMISSED_STORAGE_KEY}:${userId}`
}

export const loadTelegramPromoDismissedUntil = Effect.fn(
  'telegramPromo.loadDismissedUntil',
)(function*(userId: string) {
  if (getSyrnikeDesktop()) {
    const settings = yield* loadDesktopLocalSettingsEffect()
    return settings?.ui.telegramPromoDismissedUntilByUser[userId]
  }

  return yield* Effect.try({
    try: () => {
      const storedValue = Number(
        window.localStorage.getItem(browserStorageKey(userId)),
      )
      return Number.isFinite(storedValue) && storedValue > 0
        ? storedValue
        : undefined
    },
    catch: () => undefined,
  }).pipe(Effect.catch((value) => Effect.succeed(value)))
})

export const saveTelegramPromoDismissedUntil = Effect.fn(
  'telegramPromo.saveDismissedUntil',
)(function*(userId: string, dismissedUntil: number) {
  if (getSyrnikeDesktop()) {
    yield* updateDesktopLocalSettingsEffect({
      ui: {
        telegramPromoDismissedUntilByUser: {
          [userId]: dismissedUntil,
        },
      },
    })
    return
  }

  yield* Effect.try({
    try: () => {
      window.localStorage.setItem(
        browserStorageKey(userId),
        String(dismissedUntil),
      )
    },
    catch: () => undefined,
  }).pipe(Effect.catch(() => Effect.void))
})
