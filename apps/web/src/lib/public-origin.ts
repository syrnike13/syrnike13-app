import { env } from '#/env'

export const PUBLIC_APP_ORIGIN = env.VITE_PUBLIC_APP_URL

export function publicAppUrl(path: string) {
  return `${PUBLIC_APP_ORIGIN}${path.startsWith('/') ? path : `/${path}`}`
}
