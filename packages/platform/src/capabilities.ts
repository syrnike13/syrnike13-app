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
  /** Hybrid WGC/DXGI/GDI захват через desktop native runtime (Windows). */
  nativeScreenShare: boolean
  /** Прозрачный voice overlay поверх windowed/borderless игр (Windows). */
  desktopOverlay: boolean
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
    nativeScreenShare: desktop && os === 'win32',
    desktopOverlay: desktop && os === 'win32',
    customWindowChrome: desktop,
  }
}
