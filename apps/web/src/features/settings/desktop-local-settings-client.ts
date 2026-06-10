import type {
  DesktopLocalSettings,
  DesktopLocalSettingsPatch,
} from '@syrnike13/platform'

import { getSyrnikeDesktop } from '#/platform/runtime'

let cachedSettings: DesktopLocalSettings | null = null
let loadPromise: Promise<DesktopLocalSettings | null> | null = null
let updateQueue = Promise.resolve<DesktopLocalSettings | null>(null)

export function loadDesktopLocalSettings() {
  const desktop = getSyrnikeDesktop()
  if (!desktop) return Promise.resolve(null)

  loadPromise ??= desktop.settings
    .load()
    .then((settings) => {
      cachedSettings = settings
      return settings
    })
    .catch(() => null)

  return loadPromise
}

export function updateDesktopLocalSettings(
  patch: DesktopLocalSettingsPatch,
): Promise<DesktopLocalSettings | null> {
  const desktop = getSyrnikeDesktop()
  if (!desktop) return Promise.resolve(null)

  updateQueue = updateQueue
    .catch(() => null)
    .then(async () => {
      if (!cachedSettings) {
        await loadDesktopLocalSettings()
      }
      cachedSettings = await desktop.settings.update(patch)
      return cachedSettings
    })

  return updateQueue
}
