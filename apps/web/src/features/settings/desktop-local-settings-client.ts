import type {
  DesktopLocalSettings,
  DesktopLocalSettingsPatch,
} from '@syrnike13/platform'
import { Effect, Semaphore } from 'effect'

import { getSyrnikeDesktop } from '#/platform/runtime'

let cachedSettings: DesktopLocalSettings | null = null
const loadSemaphore = Semaphore.makeUnsafe(1)
const updateSemaphore = Semaphore.makeUnsafe(1)

export const loadDesktopLocalSettingsEffect = Effect.fn(
  'desktopLocalSettings.load',
)(function*() {
  const desktop = getSyrnikeDesktop()
  if (!desktop) return null

  return yield* loadSemaphore.withPermit(
    Effect.suspend(() => {
      if (cachedSettings) return Effect.succeed(cachedSettings)
      return Effect.tryPromise({
        try: () => desktop.settings.load(),
        catch: (cause) => cause,
      }).pipe(
        Effect.tap((settings) =>
          Effect.sync(() => {
            cachedSettings = settings
          }),
        ),
        Effect.catch(() => Effect.succeed(null)),
      )
    }),
  )
})

export function loadDesktopLocalSettings() {
  return Effect.runPromise(loadDesktopLocalSettingsEffect())
}

export const updateDesktopLocalSettingsEffect = Effect.fn(
  'desktopLocalSettings.update',
)(function*(patch: DesktopLocalSettingsPatch) {
  const desktop = getSyrnikeDesktop()
  if (!desktop) return null

  return yield* updateSemaphore.withPermit(
    Effect.gen(function*() {
      if (!cachedSettings) {
        yield* loadDesktopLocalSettingsEffect()
      }
      cachedSettings = yield* Effect.tryPromise({
        try: () => desktop.settings.update(patch),
        catch: (cause) => cause,
      })
      return cachedSettings
    }),
  )
})

export function updateDesktopLocalSettings(
  patch: DesktopLocalSettingsPatch,
): Promise<DesktopLocalSettings | null> {
  return Effect.runPromise(updateDesktopLocalSettingsEffect(patch))
}
