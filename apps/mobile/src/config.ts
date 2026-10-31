import { configureApiClient } from '@syrnike13/client/api/client'

/**
 * Backend host. Browser builds get it at build time (production or nightly,
 * like the web app); the APK is production-only and dev builds use nightly.
 */
const HOST = process.env.EXPO_PUBLIC_BACKEND_HOST || (__DEV__ ? 'beta.syrnike13.ru' : 'syrnike13.ru')

export const API_URL = `https://${HOST}/api`
export const WS_URL = `wss://${HOST}/ws`
export const MEDIA_URL = `https://${HOST}/autumn`
/** The web app, which serves invite links (`/invite/<code>`) and this app at `/m`. */
export const APP_URL = `https://app.${HOST}`
/** Sessions are per backend, so switching builds never reuses a foreign token. */
export const SESSION_KEY = `session.${HOST}`
/** The newest release APK, published next to the desktop downloads. */
export const APK_FEED_URL = 'https://syrnike13.ru/downloads/mobile/latest.json'

configureApiClient({ apiUrl: API_URL, mediaUrl: MEDIA_URL })
