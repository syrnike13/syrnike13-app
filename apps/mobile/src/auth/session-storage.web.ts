import { DesktopStoredSessionSchema } from '@syrnike13/platform'
import { Option, Schema } from 'effect'

import type { Session } from './session'

// The same entry the web app uses on this origin, so signing in on one signs
// in on the other (see apps/web/src/lib/session.ts).
const WEB_SESSION_KEY = 'syrnike13:session'
const StoredSessionJson = Schema.fromJsonString(DesktopStoredSessionSchema)

export async function readStoredSession(): Promise<Session | null> {
  try {
    const raw = localStorage.getItem(WEB_SESSION_KEY)
    const stored = raw ? Option.getOrNull(Schema.decodeUnknownOption(StoredSessionJson)(raw)) : null
    return stored ? { sessionId: stored._id, token: stored.token, userId: stored.user_id } : null
  } catch {
    return null
  }
}

export async function writeStoredSession(session: Session) {
  localStorage.setItem(
    WEB_SESSION_KEY,
    Schema.encodeSync(StoredSessionJson)({ _id: session.sessionId, token: session.token, user_id: session.userId }),
  )
}

export async function deleteStoredSession() {
  localStorage.removeItem(WEB_SESSION_KEY)
}
