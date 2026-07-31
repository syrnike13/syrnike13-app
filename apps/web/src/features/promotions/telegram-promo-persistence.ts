import {
  loadDesktopLocalSettings,
  updateDesktopLocalSettings,
} from '#/features/settings/desktop-local-settings-client'
import { getSyrnikeDesktop } from '#/platform/runtime'

export const TELEGRAM_PROMO_DISMISSED_STORAGE_KEY =
  'syrnike13.telegramPromoDismissed'

function browserStorageKey(userId: string) {
  return `${TELEGRAM_PROMO_DISMISSED_STORAGE_KEY}:${userId}`
}

export async function loadTelegramPromoDismissedUntil(userId: string) {
  if (getSyrnikeDesktop()) {
    const settings = await loadDesktopLocalSettings()
    return settings?.ui.telegramPromoDismissedUntilByUser[userId]
  }

  try {
    const storedValue = Number(
      window.localStorage.getItem(browserStorageKey(userId)),
    )
    return Number.isFinite(storedValue) && storedValue > 0
      ? storedValue
      : undefined
  } catch {
    return undefined
  }
}

export async function saveTelegramPromoDismissedUntil(
  userId: string,
  dismissedUntil: number,
) {
  if (getSyrnikeDesktop()) {
    await updateDesktopLocalSettings({
      ui: {
        telegramPromoDismissedUntilByUser: {
          [userId]: dismissedUntil,
        },
      },
    })
    return
  }

  try {
    window.localStorage.setItem(
      browserStorageKey(userId),
      String(dismissedUntil),
    )
  } catch {
    // Состояние React всё равно скрывает промо до следующей загрузки.
  }
}
