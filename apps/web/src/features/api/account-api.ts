import type {
  DataCreateAccount,
  DataPasswordReset,
  DataResendVerification,
  DataSendPasswordReset,
  MFATicket,
} from '@syrnike13/api-types'

import { apiRequest } from '#/lib/api/client'

export async function createAccount(payload: DataCreateAccount) {
  return apiRequest<void>('/auth/account/create', {
    method: 'POST',
    body: payload,
  })
}

export type VerifyAccountResponse = {
  ticket?: MFATicket
}

export async function verifyAccount(token: string) {
  return apiRequest<VerifyAccountResponse>(`/auth/account/verify/${token}`, {
    method: 'POST',
  })
}

export async function resendVerification(payload: DataResendVerification) {
  return apiRequest<void>('/auth/account/reverify', {
    method: 'POST',
    body: payload,
  })
}

export async function sendPasswordReset(email: string) {
  const body: DataSendPasswordReset = { email }
  return apiRequest<void>('/auth/account/reset_password', {
    method: 'POST',
    body,
  })
}

export async function changeAccountPassword(
  token: string,
  password: string,
  currentPassword: string,
) {
  return apiRequest<void>('/auth/account/change/password', {
    method: 'PATCH',
    token,
    body: {
      password,
      current_password: currentPassword,
    },
  })
}

export async function confirmPasswordReset(
  token: string,
  password: string,
  removeSessions = true,
) {
  const body: DataPasswordReset = {
    token,
    password,
    remove_sessions: removeSessions,
  }
  return apiRequest<void>('/auth/account/reset_password', {
    method: 'PATCH',
    body,
  })
}
