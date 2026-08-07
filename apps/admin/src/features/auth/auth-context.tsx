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
import { Effect } from 'effect'
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
  loginWithCredentialsEffect,
  loginWithMfaEffect,
  logoutSessionEffect,
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
  login: (credentials: LoginCredentials) => Effect.Effect<void, unknown>
  submitMfaPassword: (password: string) => Effect.Effect<void, unknown>
  cancelMfa: () => void
  logout: () => Effect.Effect<void>
  refreshUser: () => Effect.Effect<void, unknown>
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
    queryFn: ({ signal }) => fetchCurrentUser(session!.token, signal),
    enabled: hydrated && !!session?.token,
    retry: false,
  })

  const applySession = useCallback(
    (next: StoredSession) =>
      Effect.uninterruptible(
        Effect.sync(() => {
          saveSession(next)
          setSession(next)
          setMfaChallenge(null)
        }),
      ).pipe(
        Effect.andThen(
          Effect.tryPromise({
            try: () =>
              queryClient.invalidateQueries({
                queryKey: queryKeys.auth.session,
              }),
            catch: (cause) => cause,
          }).pipe(Effect.ignore),
        ),
      ),
    [queryClient],
  )

  const login = useCallback(
    (credentials: LoginCredentials) =>
      loginWithCredentialsEffect(credentials).pipe(
        Effect.flatMap((response) => {
          if (isLoginSuccess(response)) {
            return applySession({
              _id: response._id,
              token: response.token,
              user_id: response.user_id,
            }).pipe(
              Effect.tap(() =>
                Effect.sync(() => toast.success('Вы вошли в админку')),
              ),
            )
          }

          if (isLoginMfa(response)) {
            return Effect.sync(() => {
              setMfaChallenge({
                ticket: response.ticket,
                allowedMethods: response.allowed_methods,
              })
              toast.message('Нужна двухфакторная аутентификация')
            })
          }

          return Effect.sync(() => toast.error('Аккаунт отключён'))
        }),
      ),
    [applySession],
  )

  const submitMfaPassword = useCallback(
    (password: string) => {
      if (!mfaChallenge) return Effect.void
      const payload: MfaLoginPayload = {
        mfa_ticket: mfaChallenge.ticket,
        mfa_response: { password },
      }
      return loginWithMfaEffect(payload).pipe(
        Effect.flatMap((response) => {
          if (!isLoginSuccess(response)) {
            return Effect.sync(() =>
              toast.error('Не удалось подтвердить вход'),
            )
          }

          return applySession({
            _id: response._id,
            token: response.token,
            user_id: response.user_id,
          }).pipe(
            Effect.tap(() =>
              Effect.sync(() => toast.success('Вы вошли в админку')),
            ),
          )
        }),
      )
    },
    [applySession, mfaChallenge],
  )

  const logout = useCallback(() => {
    const token = session?.token
    return Effect.sync(() => {
      clearSession()
      setSession(null)
      setMfaChallenge(null)
      queryClient.removeQueries()
    }).pipe(
      Effect.andThen(
        token
          ? logoutSessionEffect(token).pipe(
              Effect.catch(() =>
                Effect.sync(() =>
                  toast.error('Сессия очищена локально, сервер не ответил'),
                ),
              ),
            )
          : Effect.void,
      ),
    )
  }, [queryClient, session?.token])

  const refreshUser = useCallback(
    () =>
      Effect.tryPromise({
        try: () =>
          queryClient.invalidateQueries({
            queryKey: queryKeys.auth.session,
          }),
        catch: (cause) => cause,
      }).pipe(Effect.asVoid),
    [queryClient],
  )

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
