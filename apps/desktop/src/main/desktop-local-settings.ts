import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'

import {
  DEFAULT_DESKTOP_LOCAL_SETTINGS,
  DesktopLocalSettingsSchema,
  type DesktopLocalSettings,
  type DesktopLocalSettingsPatch,
  normalizeDesktopLocalSettings,
  normalizeDesktopLocalSettingsPatch,
} from '@syrnike13/platform'
import { Effect, Option, Schema, Semaphore } from 'effect'

type SettingsWriteQueue = {
  readonly semaphore: Semaphore.Semaphore
  users: number
}

const settingsWriteQueues = new Map<string, SettingsWriteQueue>()
const UnknownSettingsRecordSchema = Schema.Record(
  Schema.String,
  Schema.Unknown,
)
const SettingsJsonSchema = Schema.fromJsonString(
  UnknownSettingsRecordSchema,
)
const DesktopLocalSettingsJsonSchema = Schema.fromJsonString(
  DesktopLocalSettingsSchema,
)

export function desktopLocalSettingsDefaults(
  platform: NodeJS.Platform = process.platform,
): DesktopLocalSettings {
  return {
    ...DEFAULT_DESKTOP_LOCAL_SETTINGS,
    voice: {
      ...DEFAULT_DESKTOP_LOCAL_SETTINGS.voice,
      screenShareQuality:
        platform === 'win32'
          ? 'high60'
          : DEFAULT_DESKTOP_LOCAL_SETTINGS.voice.screenShareQuality,
    },
  }
}

export const loadDesktopLocalSettingsEffect = Effect.fn(
  'desktopLocalSettings.load',
)(function*(
  filePath: string,
  defaults: DesktopLocalSettings = DEFAULT_DESKTOP_LOCAL_SETTINGS,
) {
  const parsed = yield* readDesktopLocalSettingsRecordEffect(filePath)
  if (!parsed) return defaults
  if (isCurrentSettingsVersion(parsed)) {
    return normalizeDesktopLocalSettings(parsed, defaults)
  }

  return yield* serializeSettingsWriteEffect(
    filePath,
    Effect.gen(function*() {
      const latest = yield* readDesktopLocalSettingsRecordEffect(filePath)
      if (!latest) return defaults
      const normalized = normalizeDesktopLocalSettings(latest, defaults)
      if (!isCurrentSettingsVersion(latest)) {
        yield* writeDesktopLocalSettingsAtomicallyEffect(filePath, normalized)
      }
      return normalized
    }),
  )
})

export function loadDesktopLocalSettings(
  filePath: string,
  defaults: DesktopLocalSettings = DEFAULT_DESKTOP_LOCAL_SETTINGS,
) {
  return Effect.runPromise(loadDesktopLocalSettingsEffect(filePath, defaults))
}

export const saveDesktopLocalSettingsEffect = Effect.fn(
  'desktopLocalSettings.save',
)(function*(
  filePath: string,
  settings: DesktopLocalSettings,
) {
  yield* serializeSettingsWriteEffect(
    filePath,
    writeDesktopLocalSettingsAtomicallyEffect(filePath, settings),
  )
})

export function saveDesktopLocalSettings(
  filePath: string,
  settings: DesktopLocalSettings,
) {
  return Effect.runPromise(saveDesktopLocalSettingsEffect(filePath, settings))
}

export const updateDesktopLocalSettingsEffect = Effect.fn(
  'desktopLocalSettings.update',
)(function*(
  filePath: string,
  patch: DesktopLocalSettingsPatch,
  defaults: DesktopLocalSettings = DEFAULT_DESKTOP_LOCAL_SETTINGS,
) {
  return yield* serializeSettingsWriteEffect(
    filePath,
    Effect.gen(function*() {
      const current = yield* readDesktopLocalSettingsEffect(filePath, defaults)
      const normalizedPatch = normalizeDesktopLocalSettingsPatch(patch)
      const result: DesktopLocalSettings = {
        version: 3,
        voice: {
          ...current.voice,
          ...normalizedPatch.voice,
        },
        voiceListener: {
          ...current.voiceListener,
          ...normalizedPatch.voiceListener,
        },
        overlay: {
          ...current.overlay,
          ...normalizedPatch.overlay,
        },
        appearance: {
          ...current.appearance,
          ...normalizedPatch.appearance,
        },
        sounds: {
          ...current.sounds,
          ...normalizedPatch.sounds,
        },
        observability: {
          ...current.observability,
          ...normalizedPatch.observability,
        },
        ui: {
          ...current.ui,
          ...normalizedPatch.ui,
          telegramPromoDismissedUntilByUser: {
            ...current.ui.telegramPromoDismissedUntilByUser,
            ...normalizedPatch.ui?.telegramPromoDismissedUntilByUser,
          },
        },
      }
      yield* writeDesktopLocalSettingsAtomicallyEffect(filePath, result)
      return result
    }),
  )
})

export function updateDesktopLocalSettings(
  filePath: string,
  patch: DesktopLocalSettingsPatch,
  defaults: DesktopLocalSettings = DEFAULT_DESKTOP_LOCAL_SETTINGS,
) {
  return Effect.runPromise(
    updateDesktopLocalSettingsEffect(filePath, patch, defaults),
  )
}

const readDesktopLocalSettingsEffect = Effect.fn(
  'desktopLocalSettings.read',
)(function*(
  filePath: string,
  defaults: DesktopLocalSettings,
) {
  const stored = yield* readDesktopLocalSettingsRecordEffect(filePath)
  return stored
    ? normalizeDesktopLocalSettings(stored, defaults)
    : defaults
})

const readDesktopLocalSettingsRecordEffect = Effect.fn(
  'desktopLocalSettings.readRecord',
)(function*(filePath: string) {
  return yield* Effect.tryPromise({
    try: () => readFile(filePath, 'utf8'),
    catch: (cause) => cause,
  }).pipe(
    Effect.map((raw) =>
      Option.getOrUndefined(
        Schema.decodeUnknownOption(SettingsJsonSchema)(raw),
      ),
    ),
    Effect.catch(() => Effect.succeed(undefined)),
  )
})

function isCurrentSettingsVersion(value: Record<string, unknown>) {
  return value.version === 3
}

function serializeSettingsWriteEffect<A, E, R>(
  filePath: string,
  write: Effect.Effect<A, E, R>,
) {
  return Effect.suspend(() => {
    let queue = settingsWriteQueues.get(filePath)
    if (!queue) {
      queue = {
        semaphore: Semaphore.makeUnsafe(1),
        users: 0,
      }
      settingsWriteQueues.set(filePath, queue)
    }
    queue.users += 1

    return queue.semaphore.withPermit(write).pipe(
      Effect.ensuring(
        Effect.sync(() => {
          queue.users -= 1
          if (
            queue.users === 0 &&
            settingsWriteQueues.get(filePath) === queue
          ) {
            settingsWriteQueues.delete(filePath)
          }
        }),
      ),
    )
  })
}

const writeDesktopLocalSettingsAtomicallyEffect = Effect.fn(
  'desktopLocalSettings.writeAtomically',
)(function*(
  filePath: string,
  settings: DesktopLocalSettings,
) {
  yield* Effect.tryPromise({
    try: () => mkdir(path.dirname(filePath), { recursive: true }),
    catch: (cause) => cause,
  })
  const temporaryPath = `${filePath}.tmp`
  yield* Effect.gen(function*() {
    yield* Effect.tryPromise({
      try: () =>
        writeFile(
          temporaryPath,
          `${Schema.encodeSync(DesktopLocalSettingsJsonSchema)(settings)}\n`,
          'utf8',
        ),
      catch: (cause) => cause,
    })
    yield* Effect.tryPromise({
      try: () => rename(temporaryPath, filePath),
      catch: (cause) => cause,
    })
  }).pipe(
    Effect.ensuring(
      Effect.tryPromise({
        try: () => rm(temporaryPath, { force: true }),
        catch: (cause) => cause,
      }).pipe(Effect.ignore),
    ),
  )
})
