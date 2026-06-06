import { env } from '#/env'

/** Публичная конфигурация клиента (бэкенд syrnike13.ru). */
export const config = {
  appTitle: env.VITE_APP_TITLE,
  appVersion: env.VITE_APP_VERSION,
  apiUrl: env.VITE_API_URL,
  wsUrl: env.VITE_WS_URL,
  mediaUrl: env.VITE_MEDIA_URL,
  proxyUrl: env.VITE_PROXY_URL,
  gifboxUrl: env.VITE_GIFBOX_URL,
  hcaptchaSiteKey: env.VITE_HCAPTCHA_SITEKEY,
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
