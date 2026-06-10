import { createFileRoute, redirect, useNavigate } from '@tanstack/react-router'
import { RiRefreshLine } from '@remixicon/react'
import { useEffect } from 'react'

import { CommandPalette } from '#/components/command-palette/command-palette'
import { SettingsModal } from '#/components/settings/settings-modal'
import { AppShell } from '#/components/layout/app-shell'
import { GatewayLoadingScreen } from '#/components/layout/gateway-loading-screen'
import { Button } from '#/components/ui/button'
import { CommandPaletteProvider } from '#/features/command-palette/command-palette-context'
import { DesktopUpdateBanner } from '#/features/desktop/desktop-update-banner'
import { DesktopHotkeyProvider } from '#/features/hotkeys/desktop-hotkey-provider'
import { DesktopOverlayPublisher } from '#/features/overlay/desktop-overlay-publisher'
import { useAuth } from '#/features/auth/auth-context'
import { SettingsModalProvider } from '#/features/settings/settings-modal-context'
import { useSyncReady } from '#/features/sync/sync-store'
import { ActivityPresenceManager } from '#/features/presence/activity-presence-manager'
import { VoiceProvider } from '#/features/voice/voice-provider'
import { postLoginPath } from '#/lib/auth-post-login-path'
import { loadSession } from '#/lib/session'
import { isDesktopRuntime } from '#/platform/runtime'

export const Route = createFileRoute('/app')({
  beforeLoad: () => {
    // localStorage недоступен при SSR — проверку сессии делаем на клиенте
    if (typeof window === 'undefined') return
    if (isDesktopRuntime()) return
    if (!loadSession()) {
      throw redirect({ to: '/login' })
    }
  },
  component: AppLayout,
})

function AppLayout() {
  return (
    <VoiceProvider>
      <AppLayoutGate />
    </VoiceProvider>
  )
}

function AppLayoutGate() {
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
    <CommandPaletteProvider>
      <SettingsModalProvider>
        <DesktopHotkeyProvider>
          <DesktopOverlayPublisher />
          <ActivityPresenceManager />
          <DesktopUpdateBanner />
          <AppShell />
          <CommandPalette />
          <SettingsModal />
        </DesktopHotkeyProvider>
      </SettingsModalProvider>
    </CommandPaletteProvider>
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
    <div className="fixed inset-0 z-[200] flex items-center justify-center bg-[#313338] px-6 text-[#f2f3f5]">
      <div className="flex w-full max-w-md flex-col items-center text-center">
        <p className="text-xs font-bold tracking-[0.12em] text-[#f2f3f5] uppercase">
          Профиль недоступен
        </p>
        <p className="mt-3 text-base leading-relaxed text-[#dbdee1]">
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
