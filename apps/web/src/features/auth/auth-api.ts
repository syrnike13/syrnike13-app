import type { DataLogin, ResponseLogin } from '@syrnike13/api-types'
import * as ApiSchema from '@syrnike13/api-types/effect-schema'
import { Effect, Schema } from 'effect'

import { apiRequestEffect } from '#/lib/api/client'

const FRIENDLY_NAME = 'syrnike13 Web (React)'

export type LoginCredentials = {
  email: string
  password: string
}

export type MfaLoginPayload = {
  mfa_ticket: string
  mfa_response: { password: string }
}

export const loginWithCredentialsEffect = Effect.fn(
  'web.auth.loginWithCredentials',
)(function*(credentials: LoginCredentials) {
  const body: DataLogin = {
    email: credentials.email,
    password: credentials.password,
    friendly_name: FRIENDLY_NAME,
  }

  return yield* apiRequestEffect(
    '/auth/session/login',
    ApiSchema.LoginLogin200,
    {
      method: 'POST',
      body,
    },
  )
})

export function loginWithCredentials(
  credentials: LoginCredentials,
  signal?: AbortSignal,
): Promise<ResponseLogin> {
  return Effect.runPromise(
    loginWithCredentialsEffect(credentials),
    signal ? { signal } : undefined,
  )
}

export const loginWithMfaEffect = Effect.fn('web.auth.loginWithMfa')(
  function*(payload: MfaLoginPayload) {
    const body: DataLogin = {
      mfa_ticket: payload.mfa_ticket,
      mfa_response: payload.mfa_response,
      friendly_name: FRIENDLY_NAME,
    }

    return yield* apiRequestEffect(
      '/auth/session/login',
      ApiSchema.LoginLogin200,
      {
        method: 'POST',
        body,
      },
    )
  },
)

export function loginWithMfa(
  payload: MfaLoginPayload,
  signal?: AbortSignal,
): Promise<ResponseLogin> {
  return Effect.runPromise(
    loginWithMfaEffect(payload),
    signal ? { signal } : undefined,
  )
}

/** После подтверждения email сервер выдаёт MFA ticket для входа. */
export const loginWithVerificationTicketEffect = Effect.fn(
  'web.auth.loginWithVerificationTicket',
)(function*(mfaTicket: string) {
  const body: DataLogin = {
    mfa_ticket: mfaTicket,
    friendly_name: FRIENDLY_NAME,
  }

  return yield* apiRequestEffect(
    '/auth/session/login',
    ApiSchema.LoginLogin200,
    {
      method: 'POST',
      body,
    },
  )
})

export function loginWithVerificationTicket(
  mfaTicket: string,
  signal?: AbortSignal,
): Promise<ResponseLogin> {
  return Effect.runPromise(
    loginWithVerificationTicketEffect(mfaTicket),
    signal ? { signal } : undefined,
  )
}

export const logoutSessionEffect = Effect.fn('web.auth.logout')(
  function*(token: string) {
    return yield* apiRequestEffect('/auth/session/logout', Schema.Void, {
      method: 'POST',
      token,
    })
  },
)

export function logoutSession(token: string, signal?: AbortSignal) {
  return Effect.runPromise(
    logoutSessionEffect(token),
    signal ? { signal } : undefined,
  )
}

export const fetchCurrentUserEffect = Effect.fn('web.auth.fetchCurrentUser')(
  function*(token: string) {
    return yield* apiRequestEffect(
      '/users/@me',
      ApiSchema.FetchSelfFetch200,
      { token },
    )
  },
)

export function fetchCurrentUser(
  token: string,
  signal?: AbortSignal,
) {
  return Effect.runPromise(
    fetchCurrentUserEffect(token),
    signal ? { signal } : undefined,
  )
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
