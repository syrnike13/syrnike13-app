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
