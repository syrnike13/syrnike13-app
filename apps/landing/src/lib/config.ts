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

/** Установщик десктопного клиента. Десктоп собирается только под Windows. */
export const desktopDownload = {
  label: 'Windows',
  url: `${downloadsBaseUrl}/syrnike13-setup.exe`,
} as const
