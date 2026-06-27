export type DesktopReleaseChannel = 'stable' | 'nightly'

export type DesktopReleaseMetadata = {
  appId: string
  autoUpdateEnabled: boolean
  displayName: string
  protocolScheme: string
  publicHost: string
}

function normalizeDesktopReleaseChannel(value: string | undefined) {
  return value === 'nightly' ? 'nightly' : 'stable'
}

export function currentDesktopReleaseChannel(): DesktopReleaseChannel {
  const compiledChannel =
    typeof __DESKTOP_RELEASE_CHANNEL__ === 'string'
      ? __DESKTOP_RELEASE_CHANNEL__
      : undefined

  return normalizeDesktopReleaseChannel(
    compiledChannel ?? process.env.SYRNIKE_DESKTOP_CHANNEL,
  )
}

export function desktopReleaseMetadata(
  channel: DesktopReleaseChannel,
): DesktopReleaseMetadata {
  if (channel === 'nightly') {
    return {
      appId: 'ru.syrnike13.desktop.nightly',
      autoUpdateEnabled: false,
      displayName: 'syrnike13 Nightly',
      protocolScheme: 'syrnike13-nightly',
      publicHost: 'beta.syrnike13.ru',
    }
  }

  return {
    appId: 'ru.syrnike13.desktop',
    autoUpdateEnabled: true,
    displayName: 'syrnike13',
    protocolScheme: 'syrnike13',
    publicHost: 'syrnike13.ru',
  }
}

export const DESKTOP_RELEASE_CHANNEL = currentDesktopReleaseChannel()
export const DESKTOP_RELEASE_METADATA = desktopReleaseMetadata(
  DESKTOP_RELEASE_CHANNEL,
)
export const DESKTOP_APP_USER_MODEL_ID = DESKTOP_RELEASE_METADATA.appId

export function desktopWindowIconAssetName(
  platform: NodeJS.Platform = process.platform,
) {
  return platform === 'win32' ? 'app.ico' : 'app-logo.png'
}
