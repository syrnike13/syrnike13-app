import { createFileRoute, redirect } from '@tanstack/react-router'

import { AchievementToastHost } from '#/components/achievements/achievement-toast-host'
import { SettingsModal } from '#/components/settings/settings-modal'
import { MobileShell } from '#/components/layout/mobile/mobile-shell'
import { MobileVoiceChannelDrawer } from '#/components/voice/mobile-voice-channel-drawer'
import { MobileVoiceChannelDrawerProvider } from '#/features/navigation/mobile-voice-channel-drawer-context'
import { CommandPaletteProvider } from '#/features/command-palette/command-palette-context'
import { AuthedGate } from '#/features/auth/authed-gate'
import { loadSession } from '#/lib/session'
import { mapMobilePathToApp, shouldUseMobileLayout } from '#/lib/device-routing'
import { UsernameResetPrompt } from '#/components/user/change-username-dialog'

/**
 * Layout route для `/m` — мобильная раскладка.
 *
 * Общий auth-gate и VoiceProvider — в `AuthedGate` (shared с `/`).
 * Здесь — только mobile-специфичная обвязка: shell, voice drawer.
 *
 * `CommandPaletteProvider` нужен, потому что `HomeSidebar` использует
 * `CommandPaletteTrigger`. Сама палитра и `Cmd+K` на мобиле не подключены —
 * провайдер служит только контейнером для UI-триггера.
 *
 * Десктоп-браузер с широким экраном, зашедший на `/m/*`, уходит обратно на
 * `/*` с сохранением path- и search-параметров.
 */
export const Route = createFileRoute('/m')({
  beforeLoad: ({ location }) => {
    if (typeof window === 'undefined') return
    if (!loadSession()) {
      throw redirect({ to: '/login' })
    }
    if (!shouldUseMobileLayout()) {
      const appPath = mapMobilePathToApp(location.pathname)
      throw redirect({
        to: appPath ?? '/',
        search: location.search,
        replace: true,
      })
    }
  },
  component: MobileLayout,
})

function MobileLayout() {
  return (
    <AuthedGate>
      <CommandPaletteProvider>
        <MobileVoiceChannelDrawerProvider>
          <MobileShell />
          <SettingsModal />
          <UsernameResetPrompt />
          <MobileVoiceChannelDrawer />
          <AchievementToastHost />
        </MobileVoiceChannelDrawerProvider>
      </CommandPaletteProvider>
    </AuthedGate>
  )
}
