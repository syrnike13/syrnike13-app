import * as SecureStore from 'expo-secure-store'

import { SESSION_KEY } from '../config'
import type { Session } from './session'

/** Android keeps the session in the encrypted keystore. */
export async function readStoredSession(): Promise<Session | null> {
  const stored = await SecureStore.getItemAsync(SESSION_KEY)
  return stored ? (JSON.parse(stored) as Session) : null
}

export async function writeStoredSession(session: Session) {
  await SecureStore.setItemAsync(SESSION_KEY, JSON.stringify(session))
}

export async function deleteStoredSession() {
  await SecureStore.deleteItemAsync(SESSION_KEY)
}
