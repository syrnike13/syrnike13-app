export const DESKTOP_APP_USER_MODEL_ID = 'ru.syrnike13.desktop'

export function desktopWindowIconAssetName(
  platform: NodeJS.Platform = process.platform,
) {
  return platform === 'win32' ? 'app.ico' : 'app-logo.png'
}
