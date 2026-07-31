// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from 'vitest'

import {
  DEFAULT_DESKTOP_LOCAL_SETTINGS,
  type DesktopLocalSettings,
  type SyrnikeDesktopApi,
} from '@syrnike13/platform'

function installDesktopSettings(settings: DesktopLocalSettings) {
  const update = vi.fn(async () => settings)
  Object.defineProperty(window, 'syrnikeDesktop', {
    configurable: true,
    value: {
      runtime: 'desktop',
      platform: { os: 'win32' },
      settings: {
        load: vi.fn(async () => settings),
        update,
      },
    } satisfies Partial<SyrnikeDesktopApi>,
  })
  return update
}

describe('Telegram promo persistence', () => {
  beforeEach(() => {
    vi.resetModules()
    localStorage.clear()
    Reflect.deleteProperty(window, 'syrnikeDesktop')
  })

  it('uses persistent desktop settings in the desktop runtime', async () => {
    const dismissedUntil = Date.now() + 10_000
    const settings: DesktopLocalSettings = {
      ...DEFAULT_DESKTOP_LOCAL_SETTINGS,
      ui: {
        telegramPromoDismissedUntilByUser: {
          userA: dismissedUntil,
        },
      },
    }
    const update = installDesktopSettings(settings)
    const {
      loadTelegramPromoDismissedUntil,
      saveTelegramPromoDismissedUntil,
    } = await import('./telegram-promo-persistence')

    await expect(loadTelegramPromoDismissedUntil('userA')).resolves.toBe(
      dismissedUntil,
    )

    const nextDismissedUntil = dismissedUntil + 1_000
    await saveTelegramPromoDismissedUntil('userB', nextDismissedUntil)
    expect(update).toHaveBeenCalledWith({
      ui: {
        telegramPromoDismissedUntilByUser: {
          userB: nextDismissedUntil,
        },
      },
    })
    expect(localStorage.length).toBe(0)
  })

  it('keeps using per-user localStorage in the browser runtime', async () => {
    const dismissedUntil = Date.now() + 10_000
    const {
      loadTelegramPromoDismissedUntil,
      saveTelegramPromoDismissedUntil,
      TELEGRAM_PROMO_DISMISSED_STORAGE_KEY,
    } = await import('./telegram-promo-persistence')

    await saveTelegramPromoDismissedUntil('userA', dismissedUntil)

    expect(
      localStorage.getItem(
        `${TELEGRAM_PROMO_DISMISSED_STORAGE_KEY}:userA`,
      ),
    ).toBe(String(dismissedUntil))
    await expect(loadTelegramPromoDismissedUntil('userA')).resolves.toBe(
      dismissedUntil,
    )
  })
})
