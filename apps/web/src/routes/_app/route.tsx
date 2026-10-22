import { createFileRoute, redirect } from '@tanstack/react-router'

import { AchievementToastHost } from '#/components/achievements/achievement-toast-host'
import { CommandPalette } from '#/components/command-palette/command-palette'
import { SettingsModal } from '#/components/settings/settings-modal'
import { DesktopShell } from '#/components/layout/desktop-shell'
import { CommandPaletteProvider } from '#/features/command-palette/command-palette-context'
import { DesktopHotkeyProvider } from '#/features/hotkeys/desktop-hotkey-provider'
import { DesktopOverlayPublisher } from '#/features/overlay/desktop-overlay-publisher'
import { DesktopTrayVoicePublisher } from '#/features/voice/desktop-tray-voice-publisher'
import { AuthedGate } from '#/features/auth/authed-gate'
import { loadSession } from '#/lib/session'
import { isDesktopRuntime } from '#/platform/runtime'
import { VoiceStreamMiniPlayer } from '#/components/voice/voice-stream-mini-player'
import { VoiceStagePopoutHost } from '#/components/voice/voice-stage-popout-host'

/**
 * Layout route для `/` — десктопная раскладка.
 *
 * Общий auth-gate и VoiceProvider — в `AuthedGate` (shared с `/m`).
 * Здесь — только desktop-специфичная обвязка: shell, горячие клавиши,
 * command palette, overlay publisher.
 */
export const Route = createFileRoute('/_app')({
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
          <DesktopTrayVoicePublisher />
          <DesktopShell />
          <VoiceStreamMiniPlayer />
          <VoiceStagePopoutHost />
          <CommandPalette />
          <SettingsModal />
          <AchievementToastHost />
        </DesktopHotkeyProvider>
      </CommandPaletteProvider>
    </AuthedGate>
  )
}
