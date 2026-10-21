const defaultAppUrl = import.meta.env.DEV
  ? 'http://localhost:3001'
  : 'https://app.syrnike13.ru'

/** Публичная конфигурация лендинга. */
export const config = {
  appTitle: import.meta.env.VITE_APP_TITLE || 'syrnike13',
  appUrl: import.meta.env.VITE_APP_URL || defaultAppUrl,
} as const

/** Базовый адрес десктоп-установщиков. */
const downloadsBaseUrl = 'https://syrnike13.ru/downloads'

export type DesktopPlatform = 'windows' | 'macos' | 'linux'

export const desktopDownloads: Record<
  DesktopPlatform,
  { label: string; file: string; url: string }
> = {
  windows: {
    label: 'Windows',
    file: 'syrnike13-setup.exe',
    url: `${downloadsBaseUrl}/syrnike13-setup.exe`,
  },
  macos: {
    label: 'macOS',
    file: 'syrnike13.dmg',
    url: `${downloadsBaseUrl}/syrnike13.dmg`,
  },
  linux: {
    label: 'Linux',
    file: 'syrnike13.AppImage',
    url: `${downloadsBaseUrl}/syrnike13.AppImage`,
  },
}
