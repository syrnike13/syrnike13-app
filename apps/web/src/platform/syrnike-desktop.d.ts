import type { SyrnikeDesktopApi } from '@syrnike13/platform'

declare global {
  interface Window {
    /** Доступен только в Electron preload (`@syrnike13/desktop`). */
    syrnikeDesktop?: SyrnikeDesktopApi
  }
}

export {}
