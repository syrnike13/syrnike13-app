import type { DataLogin, ResponseLogin, User } from '@syrnike13/api-types'

import { apiRequest } from '#/lib/api/client'

const FRIENDLY_NAME = 'syrnike13 Web (React)'

export type LoginCredentials = {
  email: string
  password: string
}

export type MfaLoginPayload = {
  mfa_ticket: string
  mfa_response: { password: string }
}

export async function loginWithCredentials(
  credentials: LoginCredentials,
): Promise<ResponseLogin> {
  const body: DataLogin = {
    email: credentials.email,
    password: credentials.password,
    friendly_name: FRIENDLY_NAME,
  }

  return apiRequest<ResponseLogin>('/auth/session/login', {
    method: 'POST',
    body,
  })
}

export async function loginWithMfa(
  payload: MfaLoginPayload,
): Promise<ResponseLogin> {
  const body: DataLogin = {
    mfa_ticket: payload.mfa_ticket,
    mfa_response: payload.mfa_response,
    friendly_name: FRIENDLY_NAME,
  }

  return apiRequest<ResponseLogin>('/auth/session/login', {
    method: 'POST',
    body,
  })
}

/** После подтверждения email сервер выдаёт MFA ticket для входа. */
export async function loginWithVerificationTicket(
  mfaTicket: string,
): Promise<ResponseLogin> {
  const body: DataLogin = {
    mfa_ticket: mfaTicket,
    friendly_name: FRIENDLY_NAME,
  }

  return apiRequest<ResponseLogin>('/auth/session/login', {
    method: 'POST',
    body,
  })
}

export async function logoutSession(token: string) {
  return apiRequest('/auth/session/logout', {
    method: 'POST',
    token,
  })
}

export async function fetchCurrentUser(token: string) {
  return apiRequest<User>('/users/@me', { token })
}

export function isLoginSuccess(
  response: ResponseLogin,
): response is Extract<ResponseLogin, { result: 'Success' }> {
  return response.result === 'Success'
}

export function isLoginMfa(
  response: ResponseLogin,
): response is Extract<ResponseLogin, { result: 'MFA' }> {
  return response.result === 'MFA'
}
