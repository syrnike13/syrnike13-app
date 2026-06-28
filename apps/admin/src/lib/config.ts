import { env } from '#/env'

export const config = {
  appTitle: env.VITE_APP_TITLE,
  appVersion: env.VITE_APP_VERSION,
  releaseChannel: env.VITE_RELEASE_CHANNEL,
  apiUrl: env.VITE_API_URL,
  adminWebUrl: env.VITE_ADMIN_WEB_URL,
} as const
