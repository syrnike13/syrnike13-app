import type { ResponseLogin } from '@syrnike13/api-types'
import { Platform } from 'react-native'

import { API_URL } from '../config'
import { deleteStoredSession, readStoredSession, writeStoredSession } from './session-storage'

export type Session = Readonly<{ sessionId: string; token: string; userId: string }>

export type LoginResult =
  | Readonly<{ type: 'success'; session: Session }>
  | Readonly<{ type: 'mfa' }>
  | Readonly<{ type: 'disabled' }>

export async function login(email: string, password: string): Promise<LoginResult> {
  const response = await fetch(`${API_URL}/auth/session/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      email,
      password,
      friendly_name: Platform.OS === 'web' ? 'syrnike13 Mobile Web' : 'syrnike13 Android',
    }),
  })
  if (!response.ok) throw new Error(`login_failed_${response.status}`)

  const body = (await response.json()) as ResponseLogin
  if (body.result === 'MFA') return { type: 'mfa' }
  if (body.result !== 'Success') return { type: 'disabled' }

  const session = { sessionId: body._id, token: body.token, userId: body.user_id }
  await writeStoredSession(session)
  return { type: 'success', session }
}

export function loadSession() {
  return readStoredSession()
}

export async function clearSession() {
  await deleteStoredSession()
}
