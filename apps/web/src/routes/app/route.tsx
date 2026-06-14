import { createFileRoute, redirect } from '@tanstack/react-router'

import { CommandPalette } from '#/components/command-palette/command-palette'
import { SettingsModal } from '#/components/settings/settings-modal'
import { DesktopShell } from '#/components/layout/desktop-shell'
import { CommandPaletteProvider } from '#/features/command-palette/command-palette-context'
import { DesktopUpdateBanner } from '#/features/desktop/desktop-update-banner'
import { DesktopHotkeyProvider } from '#/features/hotkeys/desktop-hotkey-provider'
import { DesktopOverlayPublisher } from '#/features/overlay/desktop-overlay-publisher'
import { AuthedGate } from '#/features/auth/authed-gate'
import { loadSession } from '#/lib/session'
import { isDesktopRuntime } from '#/platform/runtime'

/**
 * Layout route для `/app` — десктопная раскладка.
 *
 * Общий auth-gate и VoiceProvider — в `AuthedGate` (shared с `/m`).
 * Здесь — только desktop-специфичная обвязка: shell, горячие клавиши,
 * command palette, overlay publisher, баннер обновления.
 */
export const Route = createFileRoute('/app')({
  beforeLoad: () => {
    if (typeof window === 'undefined') return
    if (isDesktopRuntime()) return
    if (!loadSession()) {
      throw redirect({ to: '/login' })
    }
  },
  component: DesktopLayout,
})

function DesktopLayout() {
  return (
    <AuthedGate>
      <CommandPaletteProvider>
        <DesktopHotkeyProvider>
          <DesktopOverlayPublisher />
          <DesktopUpdateBanner />
          <DesktopShell />
          <CommandPalette />
          <SettingsModal />
        </DesktopHotkeyProvider>
      </CommandPaletteProvider>
    </AuthedGate>
  )
}
