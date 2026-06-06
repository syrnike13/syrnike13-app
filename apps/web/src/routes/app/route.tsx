import { createFileRoute, redirect, useNavigate } from '@tanstack/react-router'
import { useEffect } from 'react'

import { CommandPalette } from '#/components/command-palette/command-palette'
import { SettingsModal } from '#/components/settings/settings-modal'
import { AppShell } from '#/components/layout/app-shell'
import { GatewayLoadingScreen } from '#/components/layout/gateway-loading-screen'
import { CommandPaletteProvider } from '#/features/command-palette/command-palette-context'
import { DesktopUpdateBanner } from '#/features/desktop/desktop-update-banner'
import { DesktopHotkeyProvider } from '#/features/hotkeys/desktop-hotkey-provider'
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
