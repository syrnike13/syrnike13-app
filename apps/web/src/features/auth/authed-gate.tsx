import { useNavigate } from '@tanstack/react-router'
import { RiRefreshLine } from '@remixicon/react'
import { type ReactNode, useEffect } from 'react'

import { GatewayLoadingScreen } from '#/components/layout/gateway-loading-screen'
import { Button } from '#/components/ui/button'
import { useAuth } from '#/features/auth/auth-context'
import { SettingsModalProvider } from '#/features/settings/settings-modal-context'
import { ActivityPresenceManager } from '#/features/presence/activity-presence-manager'
import { VoiceProvider } from '#/features/voice/voice-provider'
import { useSyncReady } from '#/features/sync/sync-store'
import { postLoginPath } from '#/lib/auth-post-login-path'

/**
 * Общий gate для авторизованных зон (`/app`, `/m`).
 *
 * Поднимает VoiceProvider (одна голосовая сессия), проверяет auth/onboarding/sync,
 * показывает GatewayLoadingScreen / ProfileLoadErrorScreen на время загрузки,
 * навешивает ActivityPresenceManager и SettingsModalProvider.
 *
 * Используется layout-роутами `/app` и `/m`, поэтому VoiceProvider один
 * в любой момент времени — пользователь не может быть одновременно
 * в десктопной и мобильной зоне.
 */
export function AuthedGate({ children }: { children: ReactNode }) {
  return (
    <VoiceProvider>
      <AuthedGateInner>{children}</AuthedGateInner>
    </VoiceProvider>
  )
}

function AuthedGateInner({ children }: { children: ReactNode }) {
  const ready = useSyncReady()
  const auth = useAuth()
  const navigate = useNavigate()

  useEffect(() => {
    if (!auth.hydrated) return
    if (!auth.session) {
      void navigate({ to: '/login', replace: true })
      return
    }
    if (auth.onboardingChecked && auth.needsOnboarding) {
      void navigate({ to: postLoginPath(true), replace: true })
    }
  }, [
    auth.hydrated,
    auth.needsOnboarding,
    auth.onboardingChecked,
    auth.session,
    navigate,
  ])

  const waitingForUser =
    auth.session &&
    auth.onboardingChecked &&
    !auth.needsOnboarding &&
    !auth.user &&
    auth.isLoading

  const waitingForSync =
    auth.session &&
    auth.onboardingChecked &&
    !auth.needsOnboarding &&
    auth.user &&
    !ready

  if (
    auth.session &&
    auth.onboardingChecked &&
    !auth.needsOnboarding &&
    !auth.user &&
    auth.profileLoadError
  ) {
    return (
      <ProfileLoadErrorScreen
        message={auth.profileLoadError.message}
        retry={auth.retryProfileLoad}
      />
    )
  }

  if (
    !auth.hydrated ||
    !auth.session ||
    !auth.onboardingChecked ||
    auth.needsOnboarding ||
    waitingForUser ||
    waitingForSync
  ) {
    return <GatewayLoadingScreen gatewayState={auth.gatewayState} />
  }

  return (
    <SettingsModalProvider>
      <ActivityPresenceManager />
      {children}
    </SettingsModalProvider>
  )
}

function ProfileLoadErrorScreen({
  message,
  retry,
}: {
  message: string
  retry: () => Promise<void>
}) {
  return (
    <div className="gradient-surface-content fixed inset-0 z-[200] flex items-center justify-center bg-background px-6 text-foreground">
      <div className="flex w-full max-w-md flex-col items-center text-center">
        <p className="text-xs font-bold tracking-[0.12em] text-foreground uppercase">
          Профиль недоступен
        </p>
        <p className="mt-3 text-base leading-relaxed text-muted-foreground">
          {message || 'Не удалось загрузить профиль'}
        </p>
        <Button
          type="button"
          className="mt-6"
          onClick={() => {
            void retry()
          }}
        >
          <RiRefreshLine aria-hidden="true" />
          Повторить
        </Button>
      </div>
    </div>
  )
}
