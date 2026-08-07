import {
  DesktopStoredSessionSchema,
  type DesktopStoredSession,
} from '@syrnike13/platform'
import { Effect, Option, Schema } from 'effect'

const SESSION_KEY = 'syrnike13:session'

const StoredSessionJsonSchema = Schema.fromJsonString(
  DesktopStoredSessionSchema,
)

export type StoredSession = DesktopStoredSession

export function loadSession(): StoredSession | null {
  if (typeof window === 'undefined') return null
  try {
    const raw = localStorage.getItem(SESSION_KEY)
    if (!raw) return null
    return Option.getOrNull(
      Schema.decodeUnknownOption(StoredSessionJsonSchema)(raw),
    )
  } catch {
    return null
  }
}

export const loadPersistedSessionEffect = Effect.fn(
  'web.session.loadPersisted',
)(function*() {
  const desktop =
    typeof window === 'undefined' ? undefined : window.syrnikeDesktop
  if (desktop?.runtime === 'desktop') {
    return yield* Effect.tryPromise({
      try: () => desktop.auth.loadSession(),
      catch: (cause) => cause,
    })
  }

  return yield* Effect.sync(loadSession)
})

export function loadPersistedSession(): Promise<StoredSession | null> {
  return Effect.runPromise(loadPersistedSessionEffect())
}

export const saveSessionEffect = Effect.fn('web.session.save')(
  function*(session: StoredSession) {
    const desktop =
      typeof window === 'undefined' ? undefined : window.syrnikeDesktop
    if (desktop?.runtime === 'desktop') {
      return yield* Effect.tryPromise({
        try: () => desktop.auth.saveSession(session),
        catch: (cause) => cause,
      })
    }

    return yield* Effect.try({
      try: () =>
        localStorage.setItem(
          SESSION_KEY,
          Schema.encodeSync(StoredSessionJsonSchema)(session),
        ),
      catch: (cause) => cause,
    })
  },
)

export function saveSession(session: StoredSession): Promise<void> {
  return Effect.runPromise(saveSessionEffect(session))
}

export const clearSessionEffect = Effect.fn('web.session.clear')(function*() {
  const desktop =
    typeof window === 'undefined' ? undefined : window.syrnikeDesktop
  if (desktop?.runtime === 'desktop') {
    return yield* Effect.tryPromise({
      try: () => desktop.auth.clearSession(),
      catch: (cause) => cause,
    })
  }

  return yield* Effect.try({
    try: () => localStorage.removeItem(SESSION_KEY),
    catch: (cause) => cause,
  })
})

export function clearSession(): Promise<void> {
  return Effect.runPromise(clearSessionEffect())
}
