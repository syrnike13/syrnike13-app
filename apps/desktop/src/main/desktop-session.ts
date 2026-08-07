import { readFile, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'

import {
  DesktopStoredSessionSchema,
  type DesktopStoredSession,
} from '@syrnike13/platform'
import { Effect, Option, Schema } from 'effect'

const SESSION_FILE = 'session.json'
const FileNotFoundErrorSchema = Schema.Struct({
  code: Schema.Literal('ENOENT'),
})
const UnknownJsonSchema = Schema.fromJsonString(Schema.Unknown)
const DesktopStoredSessionJsonSchema = Schema.fromJsonString(
  DesktopStoredSessionSchema,
)

export function desktopSessionPath(userDataPath: string) {
  return path.join(userDataPath, SESSION_FILE)
}

const readDesktopSessionEffect = Effect.fn('desktopSession.read')(
  function*(filePath: string) {
    const raw = yield* Effect.tryPromise({
      try: () => readFile(filePath, 'utf8'),
      catch: (cause) => cause,
    })
    const parsed = yield* Schema.decodeUnknownEffect(UnknownJsonSchema)(raw)
    const decoded = Schema.decodeUnknownOption(DesktopStoredSessionSchema)(parsed)
    return Option.isSome(decoded) ? decoded.value : null
  },
)

export const saveDesktopSessionEffect = Effect.fn('desktopSession.save')(
  function*(filePath: string, session: DesktopStoredSession) {
    if (
      Option.isNone(
        Schema.decodeUnknownOption(DesktopStoredSessionSchema)(session),
      )
    ) {
      return yield* Effect.fail(new Error('Invalid desktop session payload'))
    }
    yield* Effect.tryPromise({
      try: () =>
        writeFile(
          filePath,
          Schema.encodeSync(DesktopStoredSessionJsonSchema)(session),
          { mode: 0o600 },
        ),
      catch: (cause) => cause,
    })
  },
)

export const clearDesktopSessionEffect = Effect.fn('desktopSession.clear')(
  function*(filePath: string) {
    yield* Effect.tryPromise({
      try: () => rm(filePath, { force: true }),
      catch: (cause) => cause,
    })
  },
)

function isFileNotFoundError(
  error: unknown,
): error is typeof FileNotFoundErrorSchema.Type {
  return Option.isSome(
    Schema.decodeUnknownOption(FileNotFoundErrorSchema)(error),
  )
}

export function loadDesktopSession(filePath: string) {
  return Effect.runPromise(loadDesktopSessionEffect(filePath))
}

export const loadDesktopSessionEffect = Effect.fn('desktopSession.load')(
  function*(filePath: string) {
    return yield* readDesktopSessionEffect(filePath).pipe(
      Effect.catchIf(isFileNotFoundError, () => Effect.succeed(null)),
    )
  },
)

export function saveDesktopSession(
  filePath: string,
  session: DesktopStoredSession,
) {
  return Effect.runPromise(saveDesktopSessionEffect(filePath, session))
}

export function clearDesktopSession(filePath: string) {
  return Effect.runPromise(clearDesktopSessionEffect(filePath))
}
