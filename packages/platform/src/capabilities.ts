import type { DesktopOs, SyrnikeRuntime } from './api'

export type PlatformCapabilities = {
  /** Раздел «Приложение» в настройках. */
  desktopSettings: boolean
  /** Discord-подобная активность (заглушка IPC, UI готов). */
  richPresence: boolean
  /** Системные уведомления вне вкладки. */
  nativeNotifications: boolean
  /** Улучшенный picker / loopback для демки экрана. */
  advancedScreenShare: boolean
  /** Нативный media engine (Windows): capture, audio, LiveKit publish. */
  nativeMediaEngine: boolean
  /** Собственные кнопки окна (macOS traffic lights остаются системными). */
  customWindowChrome: boolean
}

export function getCapabilities(
  runtime: SyrnikeRuntime,
  os?: DesktopOs | null,
): PlatformCapabilities {
  const desktop = runtime === 'desktop'
  return {
    desktopSettings: desktop,
    richPresence: desktop,
    nativeNotifications: desktop,
    advancedScreenShare: desktop,
    nativeMediaEngine: desktop && os === 'win32',
    customWindowChrome: desktop,
  }
}
