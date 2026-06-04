/** Где выполняется UI: браузер или оболочка Electron. */
export type SyrnikeRuntime = 'web' | 'desktop'

export interface DesktopVersions {
  app: string
  electron: string
  chrome: string
  node: string
}

export interface ActivityDetails {
  type: 'playing' | 'listening' | 'watching'
  name: string
  details?: string
  state?: string
}

/**
 * API, который preload пробрасывает в `window.syrnikeDesktop`.
 * Расширяйте по мере появления нативных возможностей (presence, screen share, …).
 */
export interface SyrnikeDesktopApi {
  readonly runtime: 'desktop'
  getVersions(): Promise<DesktopVersions>
  window: {
    minimize(): void
    maximize(): void
    close(): void
    isMaximized(): Promise<boolean>
  }
  activity: {
    set(details: ActivityDetails | null): Promise<void>
    clear(): Promise<void>
  }
}
