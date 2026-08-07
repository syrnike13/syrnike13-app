import * as ApiSchema from '@syrnike13/api-types/effect-schema'
import { Option, Schema } from 'effect'

const SESSION_KEY = 'syrnike13:admin:session'

const StoredSessionSchema = Schema.Struct({
  _id: ApiSchema.ResponseLogin.members[0].fields._id,
  token: ApiSchema.ResponseLogin.members[0].fields.token,
  user_id: ApiSchema.ResponseLogin.members[0].fields.user_id,
})
const StoredSessionJsonSchema = Schema.fromJsonString(StoredSessionSchema)

export type StoredSession = typeof StoredSessionSchema.Type

export function loadSession(): StoredSession | null {
  if (typeof window === 'undefined') return null
  const raw = localStorage.getItem(SESSION_KEY)
  if (!raw) return null
  return Option.getOrNull(
    Schema.decodeUnknownOption(StoredSessionJsonSchema)(raw),
  )
}

export function saveSession(session: StoredSession) {
  localStorage.setItem(
    SESSION_KEY,
    Schema.encodeSync(StoredSessionJsonSchema)(session),
  )
}

export function clearSession() {
  localStorage.removeItem(SESSION_KEY)
}
