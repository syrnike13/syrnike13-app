import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'

import { Effect, Option, Schema } from 'effect'

const DesktopPreferencesSchema = Schema.Struct({
  closeToTray: Schema.Boolean,
  openAtLogin: Schema.Boolean,
})

const UnknownRecordSchema = Schema.Record(Schema.String, Schema.Unknown)
const UnknownJsonSchema = Schema.fromJsonString(Schema.Unknown)
const DesktopPreferencesJsonSchema = Schema.fromJsonString(
  DesktopPreferencesSchema,
)

export type DesktopPreferences = typeof DesktopPreferencesSchema.Type

export const DEFAULT_DESKTOP_PREFERENCES: DesktopPreferences = {
  closeToTray: true,
  openAtLogin: true,
}

export function normalizeDesktopPreferences(value: unknown): DesktopPreferences {
  const decoded = Schema.decodeUnknownOption(UnknownRecordSchema)(value)
  const preferences = Option.isSome(decoded) ? decoded.value : {}
  const closeToTray = Schema.decodeUnknownOption(Schema.Boolean)(
    preferences.closeToTray,
  )
  const openAtLogin = Schema.decodeUnknownOption(Schema.Boolean)(
    preferences.openAtLogin,
  )
  return {
    closeToTray: Option.getOrElse(
      closeToTray,
      () => DEFAULT_DESKTOP_PREFERENCES.closeToTray,
    ),
    openAtLogin: Option.getOrElse(
      openAtLogin,
      () => DEFAULT_DESKTOP_PREFERENCES.openAtLogin,
    ),
  }
}

const readDesktopPreferencesEffect = Effect.fn('desktopPreferences.read')(
  function*(filePath: string) {
    const raw = yield* Effect.tryPromise({
      try: () => readFile(filePath, 'utf8'),
      catch: (cause) => cause,
    })
    const parsed = yield* Schema.decodeUnknownEffect(UnknownJsonSchema)(raw)
    return normalizeDesktopPreferences(parsed)
  },
)

export const saveDesktopPreferencesEffect = Effect.fn(
  'desktopPreferences.save',
)(
  function*(filePath: string, preferences: DesktopPreferences) {
    yield* Effect.tryPromise({
      try: () => mkdir(path.dirname(filePath), { recursive: true }),
      catch: (cause) => cause,
    })
    yield* Effect.tryPromise({
      try: () =>
        writeFile(
          filePath,
          `${Schema.encodeSync(DesktopPreferencesJsonSchema)(preferences)}\n`,
          'utf8',
        ),
      catch: (cause) => cause,
    })
  },
)

export const loadDesktopPreferencesEffect = Effect.fn(
  'desktopPreferences.load',
)(function*(filePath: string) {
  return yield* readDesktopPreferencesEffect(filePath).pipe(
    Effect.catchIf(() => true, () =>
      Effect.succeed({ ...DEFAULT_DESKTOP_PREFERENCES }),
    ),
  )
})

export function loadDesktopPreferences(filePath: string) {
  return Effect.runPromise(loadDesktopPreferencesEffect(filePath))
}

export function saveDesktopPreferences(
  filePath: string,
  preferences: DesktopPreferences,
) {
  return Effect.runPromise(saveDesktopPreferencesEffect(filePath, preferences))
}
