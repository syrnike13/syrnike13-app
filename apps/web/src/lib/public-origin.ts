export const PUBLIC_APP_ORIGIN = 'https://syrnike13.ru'

export function publicAppUrl(path: string) {
  return `${PUBLIC_APP_ORIGIN}${path.startsWith('/') ? path : `/${path}`}`
}
