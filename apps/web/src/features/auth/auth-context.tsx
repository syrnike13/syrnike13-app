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
import { Effect, Fiber } from 'effect'
import { toast } from 'sonner'

import { config } from '#/lib/config'
import { queryKeys } from '#/lib/api/query-keys'
import {
  clearSessionEffect,
  loadPersistedSessionEffect,
  saveSessionEffect,
  type StoredSession,
} from '#/lib/session'
import { eventsGateway, type GatewayState } from '#/features/events/gateway'
import { syncStore } from '#/features/sync/sync-store'
import { configureRendererDiagnosticAccount } from '#/features/diagnostics/diagnostic-reporter'
import {
  completeOnboardingEffect,
  fetchOnboardHelloEffect,
} from '#/features/api/onboard-api'

import type { ResponseLogin } from '@syrnike13/api-types'

import {
  fetchCurrentUserEffect,
  isLoginMfa,
  isLoginSuccess,
  loginWithCredentialsEffect,
  loginWithMfaEffect,
  loginWithVerificationTicketEffect,
  logoutSessionEffect,
  type LoginCredentials,
  type MfaLoginPayload,
} from './auth-api'
import {
  isSessionInvalidatingError,
  isTransientAuthLoadError,
} from './auth-errors'

type LoginSuccess = Extract<ResponseLogin, { result: 'Success' }>

type MfaChallenge = {
  ticket: string
  allowedMethods: string[]
}

type AuthContextValue = {
  hydrated: boolean
  session: StoredSession | null
  user: User | undefined
  isLoading: boolean
  gatewayState: GatewayState
  mfaChallenge: MfaChallenge | null
  profileLoadError: Error | null
  login: (
    credentials: LoginCredentials,
  ) => Effect.Effect<{ needsOnboarding: boolean } | undefined, unknown>
  submitMfaPassword: (
    password: string,
  ) => Effect.Effect<{ needsOnboarding: boolean } | undefined, unknown>
  cancelMfa: () => void
  logout: () => Effect.Effect<void>
  refreshUser: () => Effect.Effect<void, unknown>
  retryProfileLoad: () => Effect.Effect<void, unknown>
  /** Вход по ticket из письма подтверждения (`POST /auth/account/verify/...`). */
  completeEmailVerification: (
    mfaTicket: string,
  ) => Effect.Effect<{ needsOnboarding: boolean } | undefined, unknown>
  /** `GET /onboard/hello` — нужно выбрать username. */
  needsOnboarding: boolean
  onboardingChecked: boolean
  completeOnboarding: (username: string) => Effect.Effect<void, unknown>
}

const AuthContext = createContext<AuthContextValue | null>(null)

export function AuthProvider({ children }: { children: ReactNode }) {
  const queryClient = useQueryClient()
  const [session, setSession] = useState<StoredSession | null>(null)
  const [mfaChallenge, setMfaChallenge] = useState<MfaChallenge | null>(null)
  const [profileLoadError, setProfileLoadError] = useState<Error | null>(null)
  const [gatewayState, setGatewayState] = useState<GatewayState>('idle')
  const [hydrated, setHydrated] = useState(false)
  const applySession = useCallback((next: StoredSession | null) => {
    configureRendererDiagnosticAccount(next?.user_id ?? null)
    setSession(next)
  }, [])

  useEffect(() => {
    const fiber = Effect.runFork(
      loadPersistedSessionEffect().pipe(
        Effect.matchEffect({
          onFailure: () => Effect.sync(() => setHydrated(true)),
          onSuccess: (storedSession) =>
            Effect.sync(() => {
              applySession(storedSession)
              setHydrated(true)
            }),
        }),
      ),
    )
    return () => {
      Effect.runFork(Fiber.interrupt(fiber))
    }
  }, [applySession])

  useEffect(() => {
    const unsubscribe = eventsGateway.subscribeState(setGatewayState)
    return () => {
      unsubscribe()
    }
  }, [])

  const onboardingQuery = useQuery({
    queryKey: queryKeys.auth.onboarding(session?.token ?? ''),
    queryFn: ({ signal }) =>
      Effect.runPromise(fetchOnboardHelloEffect(session!.token), { signal }),
    enabled: hydrated && !!session?.token,
    retry: false,
  })

  const needsOnboarding = onboardingQuery.data?.onboarding === true
  const onboardingChecked =
    !session?.token || onboardingQuery.isFetched || onboardingQuery.isError

  const userQuery = useQuery({
    queryKey: queryKeys.auth.session,
    queryFn: ({ signal }) =>
      Effect.runPromise(fetchCurrentUserEffect(session!.token), { signal }),
    enabled:
      hydrated && !!session?.token && onboardingChecked && !needsOnboarding,
    retry: false,
  })

  const hasUser = Boolean(userQuery.data)

  useEffect(() => {
    if (!session?.token || needsOnboarding || !onboardingChecked || !hasUser) {
      eventsGateway.disableAutoReconnect()
      return
    }

    eventsGateway.enableAutoReconnect(config.wsUrl, session.token)
    eventsGateway.connect(config.wsUrl, session.token)

    return () => {
      eventsGateway.disableAutoReconnect()
    }
  }, [hasUser, needsOnboarding, onboardingChecked, session?.token])

  const resetSessionState = useCallback(
    (message?: string) => {
      applySession(null)
      setMfaChallenge(null)
      setProfileLoadError(null)
      eventsGateway.disableAutoReconnect()
      syncStore.reset()
      queryClient.removeQueries({ queryKey: queryKeys.auth.session })
      queryClient.removeQueries({ queryKey: queryKeys.feedback.all })
      queryClient.removeQueries({
        predicate: (query) =>
          query.queryKey[0] === 'auth' && query.queryKey[1] === 'onboarding',
      })
      if (message) toast.error(message)
    },
    [applySession, queryClient],
  )

  const invalidateSession = useCallback(
    (message?: string) => {
      Effect.runFork(clearSessionEffect().pipe(Effect.ignore))
      resetSessionState(message)
    },
    [resetSessionState],
  )

  useEffect(() => {
    const unsubscribe = eventsGateway.subscribeEvents((event) => {
      const data = event.data
      if (
        event.type === 'Error' &&
        typeof data === 'object' &&
        data !== null &&
        'type' in data &&
        data.type === 'InvalidSession'
      ) {
        invalidateSession('Сессия недействительна. Войдите снова.')
      }
    })
    return () => {
      unsubscribe()
    }
  }, [invalidateSession])

  useEffect(() => {
    if (!session?.token || !onboardingQuery.isError) return
    if (!isSessionInvalidatingError(onboardingQuery.error)) return
    invalidateSession('Сессия недействительна. Войдите снова.')
  }, [
    invalidateSession,
    onboardingQuery.error,
    onboardingQuery.isError,
    session?.token,
  ])

  const syncOnboardingStatus = useCallback(
    (token: string) =>
      fetchOnboardHelloEffect(token).pipe(
        Effect.tap((status) =>
          Effect.sync(() => {
            queryClient.setQueryData(queryKeys.auth.onboarding(token), status)
          }),
        ),
        Effect.map((status) => status.onboarding),
        Effect.tapError((error) =>
          isSessionInvalidatingError(error)
            ? Effect.sync(() => {
                invalidateSession('Сессия недействительна. Войдите снова.')
              })
            : Effect.void,
        ),
      ),
    [invalidateSession, queryClient],
  )

  const applySuccessSession = useCallback(
    (data: LoginSuccess) =>
      Effect.uninterruptible(
        Effect.gen(function*() {
          const next: StoredSession = {
            _id: data._id,
            token: data.token,
            user_id: data.user_id,
          }
          yield* saveSessionEffect(next)
          yield* Effect.sync(() => {
            applySession(next)
            setMfaChallenge(null)
            setProfileLoadError(null)
            void queryClient.invalidateQueries({
              queryKey: queryKeys.auth.session,
            })
          })
          return next.token
        }),
      ),
    [applySession, queryClient],
  )

  const login = useCallback(
    (credentials: LoginCredentials) =>
      Effect.gen(function*() {
        const response = yield* loginWithCredentialsEffect(credentials)

        if (isLoginSuccess(response)) {
          const token = yield* applySuccessSession(response)
          const needsOnboard = yield* syncOnboardingStatus(token)
          yield* Effect.sync(() => toast.success('Вы вошли в аккаунт'))
          return { needsOnboarding: needsOnboard }
        }

        if (isLoginMfa(response)) {
          yield* Effect.sync(() => {
            setMfaChallenge({
              ticket: response.ticket,
              allowedMethods: response.allowed_methods,
            })
            toast.message('Нужна двухфакторная аутентификация')
          })
          return
        }

        yield* Effect.sync(() => toast.error('Аккаунт отключён'))
      }),
    [applySuccessSession, syncOnboardingStatus],
  )

  const submitMfaPassword = useCallback(
    (password: string) =>
      Effect.gen(function*() {
        if (!mfaChallenge) return

        const payload: MfaLoginPayload = {
          mfa_ticket: mfaChallenge.ticket,
          mfa_response: { password },
        }

        const response = yield* loginWithMfaEffect(payload)

        if (isLoginSuccess(response)) {
          const token = yield* applySuccessSession(response)
          const needsOnboard = yield* syncOnboardingStatus(token)
          yield* Effect.sync(() => toast.success('Вы вошли в аккаунт'))
          return { needsOnboarding: needsOnboard }
        }

        if (isLoginMfa(response)) {
          yield* Effect.sync(() => {
            setMfaChallenge({
              ticket: response.ticket,
              allowedMethods: response.allowed_methods,
            })
            toast.error('MFA не пройдена, попробуйте снова')
          })
          return
        }

        yield* Effect.sync(() => toast.error('Аккаунт отключён'))
      }),
    [applySuccessSession, mfaChallenge, syncOnboardingStatus],
  )

  const cancelMfa = useCallback(() => {
    setMfaChallenge(null)
  }, [])

  const refreshUser = useCallback(
    () =>
      Effect.gen(function*() {
        if (!session?.token) return
        const user = yield* fetchCurrentUserEffect(session.token)
        yield* Effect.sync(() => {
          queryClient.setQueryData(queryKeys.auth.session, user)
          setProfileLoadError(null)
          syncStore.upsertUser(user)
        })
      }),
    [queryClient, session?.token],
  )

  const completeOnboarding = useCallback(
    (username: string) =>
      Effect.gen(function*() {
        if (!session?.token) return
        const token = session.token
        const user = yield* completeOnboardingEffect(token, username)
        yield* Effect.sync(() => {
          syncStore.upsertUser(user)
          queryClient.setQueryData(queryKeys.auth.session, user)
          queryClient.setQueryData(queryKeys.auth.onboarding(token), {
            onboarding: false,
          })
          toast.success('Ник установлен')
        })
      }),
    [queryClient, session?.token],
  )

  const completeEmailVerification = useCallback(
    (mfaTicket: string) =>
      Effect.gen(function*() {
        const response = yield* loginWithVerificationTicketEffect(mfaTicket)

        if (isLoginSuccess(response)) {
          const token = yield* applySuccessSession(response)
          const needsOnboard = yield* syncOnboardingStatus(token)
          yield* Effect.sync(() =>
            toast.success('Email подтверждён, вы вошли в аккаунт'),
          )
          return { needsOnboarding: needsOnboard }
        }

        if (isLoginMfa(response)) {
          yield* Effect.sync(() => {
            setMfaChallenge({
              ticket: response.ticket,
              allowedMethods: response.allowed_methods,
            })
            toast.message('Подтвердите вход паролем (MFA)')
          })
          return
        }

        yield* Effect.sync(() =>
          toast.error('Не удалось войти после подтверждения email'),
        )
      }),
    [applySuccessSession, syncOnboardingStatus],
  )

  const logout = useCallback(
    () =>
      Effect.gen(function*() {
        if (session?.token) {
          yield* logoutSessionEffect(session.token).pipe(Effect.ignore)
        }

        yield* clearSessionEffect().pipe(Effect.ignore)
        yield* Effect.sync(() => {
          resetSessionState()
          toast.success('Вы вышли из аккаунта')
        })
      }),
    [resetSessionState, session?.token],
  )

  useEffect(() => {
    if (!session?.token || userQuery.data) {
      setProfileLoadError(null)
      return
    }
    if (!session?.token || !userQuery.isError || userQuery.isFetching) return
    if (isTransientAuthLoadError(userQuery.error)) return
    if (isSessionInvalidatingError(userQuery.error)) {
      invalidateSession('Сессия недействительна. Войдите снова.')
      return
    }
    setProfileLoadError(
      userQuery.error instanceof Error
        ? userQuery.error
        : new Error('Не удалось загрузить профиль'),
    )
  }, [
    invalidateSession,
    session?.token,
    userQuery.error,
    userQuery.isError,
    userQuery.isFetching,
  ])

  const retryProfileLoad = useCallback(
    () =>
      Effect.gen(function*() {
        if (!session?.token) return
        yield* Effect.sync(() => setProfileLoadError(null))
        yield* Effect.tryPromise({
          try: () => userQuery.refetch(),
          catch: (cause) => cause,
        })
      }).pipe(Effect.asVoid),
    [session?.token, userQuery],
  )

  const profileLoadRecovering =
    !!session &&
    !needsOnboarding &&
    userQuery.isError &&
    !userQuery.data &&
    (userQuery.isFetching || isTransientAuthLoadError(userQuery.error))

  const value = useMemo<AuthContextValue>(
    () => ({
      hydrated,
      session: hydrated ? session : null,
      user: userQuery.data,
      profileLoadError,
      isLoading:
        !hydrated ||
        (!!session &&
          (!onboardingChecked ||
            (needsOnboarding
              ? false
              : userQuery.isLoading ||
                profileLoadRecovering))),
      gatewayState,
      mfaChallenge,
      login,
      submitMfaPassword,
      cancelMfa,
      logout,
      refreshUser,
      retryProfileLoad,
      completeEmailVerification,
      needsOnboarding,
      onboardingChecked,
      completeOnboarding,
    }),
    [
      cancelMfa,
      completeEmailVerification,
      completeOnboarding,
      gatewayState,
      hydrated,
      login,
      logout,
      mfaChallenge,
      needsOnboarding,
      onboardingChecked,
      profileLoadRecovering,
      profileLoadError,
      refreshUser,
      retryProfileLoad,
      session,
      submitMfaPassword,
      userQuery.data,
      userQuery.isLoading,
      userQuery.isFetching,
    ],
  )

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}

export function useAuth() {
  const context = useContext(AuthContext)
  if (!context) {
    throw new Error('useAuth must be used within AuthProvider')
  }
  return context
}
