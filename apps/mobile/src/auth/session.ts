import type { ResponseLogin } from '@syrnike13/api-types'
import * as SecureStore from 'expo-secure-store'

import { API_URL, SESSION_KEY } from '../config'

export type Session = Readonly<{ token: string; userId: string }>

export type LoginResult =
  | Readonly<{ type: 'success'; session: Session }>
  | Readonly<{ type: 'mfa' }>
  | Readonly<{ type: 'disabled' }>

export async function login(email: string, password: string): Promise<LoginResult> {
  const response = await fetch(`${API_URL}/auth/session/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password, friendly_name: 'syrnike13 Android' }),
  })
  if (!response.ok) throw new Error(`login_failed_${response.status}`)

  const body = (await response.json()) as ResponseLogin
  if (body.result === 'MFA') return { type: 'mfa' }
  if (body.result !== 'Success') return { type: 'disabled' }

  const session = { token: body.token, userId: body.user_id }
  await SecureStore.setItemAsync(SESSION_KEY, JSON.stringify(session))
  return { type: 'success', session }
}

export async function loadSession(): Promise<Session | null> {
  const stored = await SecureStore.getItemAsync(SESSION_KEY)
  return stored ? (JSON.parse(stored) as Session) : null
}

export async function clearSession() {
  await SecureStore.deleteItemAsync(SESSION_KEY)
}
