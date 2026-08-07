import type {
  DataCreateAccount,
  DataPasswordReset,
  DataResendVerification,
  DataSendPasswordReset,
} from '@syrnike13/api-types'
import * as ApiSchema from '@syrnike13/api-types/effect-schema'
import { Effect, Schema } from 'effect'

import { apiRequestEffect } from '#/lib/api/client'

export const createAccountEffect = Effect.fn('web.account.create')(
  function*(payload: DataCreateAccount) {
    return yield* apiRequestEffect('/auth/account/create', Schema.Void, {
      method: 'POST',
      body: payload,
    })
  },
)

export function createAccount(
  payload: DataCreateAccount,
  signal?: AbortSignal,
) {
  return Effect.runPromise(
    createAccountEffect(payload),
    signal ? { signal } : undefined,
  )
}

export const verifyAccountEffect = Effect.fn('web.account.verify')(
  function*(token: string) {
    return yield* apiRequestEffect(
      `/auth/account/verify/${token}`,
      ApiSchema.VerifyEmailVerifyEmail200,
      { method: 'POST' },
    )
  },
)

export function verifyAccount(token: string, signal?: AbortSignal) {
  return Effect.runPromise(
    verifyAccountEffect(token),
    signal ? { signal } : undefined,
  )
}

export const resendVerificationEffect = Effect.fn(
  'web.account.resendVerification',
)(function*(payload: DataResendVerification) {
  return yield* apiRequestEffect('/auth/account/reverify', Schema.Void, {
    method: 'POST',
    body: payload,
  })
})

export function resendVerification(
  payload: DataResendVerification,
  signal?: AbortSignal,
) {
  return Effect.runPromise(
    resendVerificationEffect(payload),
    signal ? { signal } : undefined,
  )
}

export const sendPasswordResetEffect = Effect.fn(
  'web.account.sendPasswordReset',
)(function*(email: string) {
  const body: DataSendPasswordReset = { email }
  return yield* apiRequestEffect(
    '/auth/account/reset_password',
    Schema.Void,
    {
      method: 'POST',
      body,
    },
  )
})

export function sendPasswordReset(
  email: string,
  signal?: AbortSignal,
) {
  return Effect.runPromise(
    sendPasswordResetEffect(email),
    signal ? { signal } : undefined,
  )
}

export const changeAccountPasswordEffect = Effect.fn(
  'web.account.changePassword',
)(function*(token: string, password: string, currentPassword: string) {
  return yield* apiRequestEffect(
    '/auth/account/change/password',
    Schema.Void,
    {
      method: 'PATCH',
      token,
      body: {
        password,
        current_password: currentPassword,
      },
    },
  )
})

export function changeAccountPassword(
  token: string,
  password: string,
  currentPassword: string,
  signal?: AbortSignal,
) {
  return Effect.runPromise(
    changeAccountPasswordEffect(token, password, currentPassword),
    signal ? { signal } : undefined,
  )
}

export const confirmPasswordResetEffect = Effect.fn(
  'web.account.confirmPasswordReset',
)(function*(token: string, password: string, removeSessions = true) {
  const body: DataPasswordReset = {
    token,
    password,
    remove_sessions: removeSessions,
  }
  return yield* apiRequestEffect(
    '/auth/account/reset_password',
    Schema.Void,
    {
      method: 'PATCH',
      body,
    },
  )
})

export function confirmPasswordReset(
  token: string,
  password: string,
  removeSessions = true,
  signal?: AbortSignal,
) {
  return Effect.runPromise(
    confirmPasswordResetEffect(token, password, removeSessions),
    signal ? { signal } : undefined,
  )
}
