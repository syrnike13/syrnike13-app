import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import type { User } from '@syrnike13/api-types'
import { toast } from 'sonner'

import { queryKeys } from '#/lib/api/query-keys'
import {
  clearSession,
  loadSession,
  saveSession,
  type StoredSession,
} from '#/lib/session'

import {
  fetchCurrentUser,
  isLoginMfa,
  isLoginSuccess,
  loginWithCredentials,
  loginWithMfa,
  logoutSession,
  type LoginCredentials,
  type MfaLoginPayload,
} from './auth-api'

type MfaChallenge = {
  ticket: string
  allowedMethods: string[]
}

type AuthContextValue = {
  hydrated: boolean
  session: StoredSession | null
  user: User | undefined
  isLoading: boolean
  isPrivileged: boolean
  mfaChallenge: MfaChallenge | null
  login: (credentials: LoginCredentials) => Promise<void>
  submitMfaPassword: (password: string) => Promise<void>
  cancelMfa: () => void
  logout: () => Promise<void>
  refreshUser: () => Promise<void>
}

const AuthContext = createContext<AuthContextValue | null>(null)

export function AuthProvider({ children }: { children: ReactNode }) {
  const queryClient = useQueryClient()
  const [session, setSession] = useState<StoredSession | null>(null)
  const [hydrated, setHydrated] = useState(false)
  const [mfaChallenge, setMfaChallenge] = useState<MfaChallenge | null>(null)

  useEffect(() => {
    setSession(loadSession())
    setHydrated(true)
  }, [])

  const userQuery = useQuery({
    queryKey: queryKeys.auth.session,
    queryFn: () => fetchCurrentUser(session!.token),
    enabled: hydrated && !!session?.token,
    retry: false,
  })

  const applySession = useCallback(
    (next: StoredSession) => {
      saveSession(next)
      setSession(next)
      setMfaChallenge(null)
      void queryClient.invalidateQueries({ queryKey: queryKeys.auth.session })
    },
    [queryClient],
  )

  const login = useCallback(
    async (credentials: LoginCredentials) => {
      const response = await loginWithCredentials(credentials)

      if (isLoginSuccess(response)) {
        applySession({
          _id: response._id,
          token: response.token,
          user_id: response.user_id,
        })
        toast.success('Вы вошли в админку')
        return
      }

      if (isLoginMfa(response)) {
        setMfaChallenge({
          ticket: response.ticket,
          allowedMethods: response.allowed_methods,
        })
        toast.message('Нужна двухфакторная аутентификация')
        return
      }

      toast.error('Аккаунт отключён')
    },
    [applySession],
  )

  const submitMfaPassword = useCallback(
    async (password: string) => {
      if (!mfaChallenge) return
      const payload: MfaLoginPayload = {
        mfa_ticket: mfaChallenge.ticket,
        mfa_response: { password },
      }
      const response = await loginWithMfa(payload)

      if (!isLoginSuccess(response)) {
        toast.error('Не удалось подтвердить вход')
        return
      }

      applySession({
        _id: response._id,
        token: response.token,
        user_id: response.user_id,
      })
      toast.success('Вы вошли в админку')
    },
    [applySession, mfaChallenge],
  )

  const logout = useCallback(async () => {
    const token = session?.token
    clearSession()
    setSession(null)
    setMfaChallenge(null)
    queryClient.removeQueries()
    if (token) {
      try {
        await logoutSession(token)
      } catch {
        toast.error('Сессия очищена локально, сервер не ответил')
      }
    }
  }, [queryClient, session?.token])

  const refreshUser = useCallback(async () => {
    await queryClient.invalidateQueries({ queryKey: queryKeys.auth.session })
  }, [queryClient])

  const value = useMemo<AuthContextValue>(
    () => ({
      hydrated,
      session,
      user: userQuery.data,
      isLoading: userQuery.isLoading,
      isPrivileged: userQuery.data?.privileged === true,
      mfaChallenge,
      login,
      submitMfaPassword,
      cancelMfa: () => setMfaChallenge(null),
      logout,
      refreshUser,
    }),
    [
      hydrated,
      login,
      logout,
      mfaChallenge,
      refreshUser,
      session,
      submitMfaPassword,
      userQuery.data,
      userQuery.isLoading,
    ],
  )

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}

export function useAuth() {
  const value = useContext(AuthContext)
  if (!value) {
    throw new Error('useAuth must be used inside AuthProvider')
  }
  return value
}
