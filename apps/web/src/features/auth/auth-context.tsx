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

import { config } from '#/lib/config'
import { queryKeys } from '#/lib/api/query-keys'
import {
  clearSession,
  loadPersistedSession,
  loadSession,
  saveSession,
  type StoredSession,
} from '#/lib/session'
import { eventsGateway, type GatewayState } from '#/features/events/gateway'
import { syncStore } from '#/features/sync/sync-store'
import {
  completeOnboarding as completeOnboardingRequest,
  fetchOnboardHello,
} from '#/features/api/onboard-api'

import type { ResponseLogin } from '@syrnike13/api-types'

import {
  fetchCurrentUser,
  isLoginMfa,
  isLoginSuccess,
  loginWithCredentials,
  loginWithMfa,
  loginWithVerificationTicket,
  logoutSession,
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
  ) => Promise<{ needsOnboarding: boolean } | undefined>
  submitMfaPassword: (password: string) => Promise<void>
  cancelMfa: () => void
  logout: () => Promise<void>
  refreshUser: () => Promise<void>
  retryProfileLoad: () => Promise<void>
  /** Вход по ticket из письма подтверждения (`POST /auth/account/verify/...`). */
  completeEmailVerification: (
    mfaTicket: string,
  ) => Promise<{ needsOnboarding: boolean } | undefined>
  /** `GET /onboard/hello` — нужно выбрать username. */
  needsOnboarding: boolean
  onboardingChecked: boolean
  completeOnboarding: (username: string) => Promise<void>
}

const AuthContext = createContext<AuthContextValue | null>(null)

export function AuthProvider({ children }: { children: ReactNode }) {
  const queryClient = useQueryClient()
  const [session, setSession] = useState<StoredSession | null>(null)
  const [mfaChallenge, setMfaChallenge] = useState<MfaChallenge | null>(null)
  const [profileLoadError, setProfileLoadError] = useState<Error | null>(null)
  const [gatewayState, setGatewayState] = useState<GatewayState>('idle')
  const [hydrated, setHydrated] = useState(false)

  useEffect(() => {
    let cancelled = false
    void loadPersistedSession()
      .then((storedSession) => {
        if (cancelled) return
        setSession(storedSession)
      })
      .finally(() => {
        if (!cancelled) setHydrated(true)
      })
    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    return eventsGateway.subscribeState(setGatewayState)
  }, [])

  const onboardingQuery = useQuery({
    queryKey: queryKeys.auth.onboarding(session?.token ?? ''),
    queryFn: () => fetchOnboardHello(session!.token),
    enabled: hydrated && !!session?.token,
    retry: false,
  })

  const needsOnboarding = onboardingQuery.data?.onboarding === true
  const onboardingChecked =
    !session?.token || onboardingQuery.isFetched || onboardingQuery.isError

  const userQuery = useQuery({
    queryKey: queryKeys.auth.session,
    queryFn: () => fetchCurrentUser(session!.token),
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

  const invalidateSession = useCallback(
    (message?: string) => {
      void clearSession()
      setSession(null)
      setMfaChallenge(null)
      setProfileLoadError(null)
      eventsGateway.disableAutoReconnect()
      syncStore.reset()
      queryClient.removeQueries({ queryKey: queryKeys.auth.session })
      queryClient.removeQueries({
        predicate: (query) =>
          query.queryKey[0] === 'auth' && query.queryKey[1] === 'onboarding',
      })
      if (message) toast.error(message)
    },
    [queryClient],
  )

  useEffect(() => {
    return eventsGateway.subscribeEvents((event) => {
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
    async (token: string) => {
      try {
        const status = await fetchOnboardHello(token)
        queryClient.setQueryData(queryKeys.auth.onboarding(token), status)
        return status.onboarding
      } catch (error) {
        if (isSessionInvalidatingError(error)) {
          invalidateSession('Сессия недействительна. Войдите снова.')
        }
        throw error
      }
    },
    [invalidateSession, queryClient],
  )

  const applySuccessSession = useCallback(
    async (data: LoginSuccess) => {
      const next: StoredSession = {
        _id: data._id,
        token: data.token,
        user_id: data.user_id,
      }
      await saveSession(next)
      setSession(next)
      setMfaChallenge(null)
      setProfileLoadError(null)
      void queryClient.invalidateQueries({ queryKey: queryKeys.auth.session })
      return next.token
    },
    [queryClient],
  )

  const login = useCallback(
    async (credentials: LoginCredentials) => {
      const response = await loginWithCredentials(credentials)

      if (isLoginSuccess(response)) {
        const token = await applySuccessSession(response)
        const needsOnboard = await syncOnboardingStatus(token)
        toast.success('Вы вошли в аккаунт')
        return { needsOnboarding: needsOnboard }
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
    [applySuccessSession, syncOnboardingStatus],
  )

  const submitMfaPassword = useCallback(
    async (password: string) => {
      if (!mfaChallenge) return

      const payload: MfaLoginPayload = {
        mfa_ticket: mfaChallenge.ticket,
        mfa_response: { password },
      }

      const response = await loginWithMfa(payload)

      if (isLoginSuccess(response)) {
        const token = await applySuccessSession(response)
        const needsOnboard = await syncOnboardingStatus(token)
        toast.success('Вы вошли в аккаунт')
        return { needsOnboarding: needsOnboard }
      }

      if (isLoginMfa(response)) {
        setMfaChallenge({
          ticket: response.ticket,
          allowedMethods: response.allowed_methods,
        })
        toast.error('MFA не пройдена, попробуйте снова')
        return
      }

      toast.error('Аккаунт отключён')
    },
    [applySuccessSession, mfaChallenge, syncOnboardingStatus],
  )

  const cancelMfa = useCallback(() => {
    setMfaChallenge(null)
  }, [])

  const refreshUser = useCallback(async () => {
    if (!session?.token) return
    const user = await fetchCurrentUser(session.token)
    queryClient.setQueryData(queryKeys.auth.session, user)
    setProfileLoadError(null)
    syncStore.upsertUser(user)
  }, [queryClient, session?.token])

  const completeOnboarding = useCallback(
    async (username: string) => {
      if (!session?.token) return
      const user = await completeOnboardingRequest(session.token, username)
      syncStore.upsertUser(user)
      queryClient.setQueryData(queryKeys.auth.session, user)
      queryClient.setQueryData(queryKeys.auth.onboarding(session.token), {
        onboarding: false,
      })
      toast.success('Ник установлен')
    },
    [queryClient, session?.token],
  )

  const completeEmailVerification = useCallback(
    async (mfaTicket: string) => {
      const response = await loginWithVerificationTicket(mfaTicket)

      if (isLoginSuccess(response)) {
        const token = await applySuccessSession(response)
        const needsOnboard = await syncOnboardingStatus(token)
        toast.success('Email подтверждён, вы вошли в аккаунт')
        return { needsOnboarding: needsOnboard }
      }

      if (isLoginMfa(response)) {
        setMfaChallenge({
          ticket: response.ticket,
          allowedMethods: response.allowed_methods,
        })
        toast.message('Подтвердите вход паролем (MFA)')
        return
      }

      toast.error('Не удалось войти после подтверждения email')
    },
    [applySuccessSession, syncOnboardingStatus],
  )

  const logout = useCallback(async () => {
    if (session?.token) {
      try {
        await logoutSession(session.token)
      } catch {
        // сессия могла уже истечь
      }
    }

    invalidateSession()
    toast.success('Вы вышли из аккаунта')
  }, [invalidateSession, session?.token])

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

  const retryProfileLoad = useCallback(async () => {
    if (!session?.token) return
    setProfileLoadError(null)
    await userQuery.refetch()
  }, [session?.token, userQuery])

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
