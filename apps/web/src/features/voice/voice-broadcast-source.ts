import {
  AppWindowIcon,
  GlobeIcon,
  MonitorIcon,
  VideoIcon,
  type AppIcon,
} from '#/components/icons'
import type { DesktopDisplayMediaSource } from '@syrnike13/platform'

export type ScreenShareSurface = 'monitor' | 'window' | 'browser'

export type ScreenShareBroadcastSource = {
  label: string
  surface: ScreenShareSurface
  appIconDataUrl?: string
}

type DisplaySurfaceSettings = MediaTrackSettings & {
  displaySurface?: string
}

let desktopScreenShareSource: ScreenShareBroadcastSource | null = null

export function parseScreenShareSurface(
  value: string | undefined,
): ScreenShareSurface {
  if (value === 'monitor' || value === 'window' || value === 'browser') {
    return value
  }
  return 'window'
}

export function screenShareSurfaceFallbackLabel(surface: ScreenShareSurface) {
  switch (surface) {
    case 'monitor':
      return 'Экран'
    case 'browser':
      return 'Вкладка браузера'
    case 'window':
      return 'Окно'
  }
}

export function readScreenShareBroadcastSource(
  track: MediaStreamTrack | null | undefined,
): ScreenShareBroadcastSource {
  const settings = track?.getSettings?.() as DisplaySurfaceSettings | undefined
  const surface = parseScreenShareSurface(settings?.displaySurface)
  const label = friendlyScreenShareLabel(track?.label, surface)
  return { label, surface }
}

export function rememberDesktopScreenShareBroadcastSource(
  source: Pick<DesktopDisplayMediaSource, 'name' | 'type'> &
    Partial<Pick<DesktopDisplayMediaSource, 'appIconDataUrl'>>,
) {
  const surface: ScreenShareSurface =
    source.type === 'screen' ? 'monitor' : 'window'
  desktopScreenShareSource = {
    label: friendlyScreenShareLabel(source.name, surface),
    surface,
    ...(source.appIconDataUrl
      ? { appIconDataUrl: source.appIconDataUrl }
      : undefined),
  }
}

function friendlyScreenShareLabel(
  value: string | undefined,
  surface: ScreenShareSurface,
) {
  const label = value?.trim()
  if (!label) return screenShareSurfaceFallbackLabel(surface)

  const internalScreen = /^screen:(\d+)(?::\d+)*$/i.exec(label)
  if (internalScreen) {
    return `Экран ${Number(internalScreen[1]) + 1}`
  }

  const numberedScreen = /^(?:screen|экран)\s+(\d+)(?:\s+\([^)]*\))?$/i.exec(
    label,
  )
  if (numberedScreen) {
    return `Экран ${numberedScreen[1]}`
  }

  if (/^(?:window|web-contents):\d+(?::\d+)*$/i.test(label)) {
    return 'Окно'
  }

  return label
}

export function readDesktopScreenShareBroadcastSource() {
  return desktopScreenShareSource
}

export function screenShareBroadcastIcon(
  surface: ScreenShareSurface,
): AppIcon {
  switch (surface) {
    case 'monitor':
      return MonitorIcon
    case 'browser':
      return GlobeIcon
    case 'window':
      return AppWindowIcon
  }
}

export function readCameraBroadcastLabel(
  track: MediaStreamTrack | null | undefined,
) {
  return track?.label?.trim() || 'Камера'
}

export function cameraBroadcastIcon(): AppIcon {
  return VideoIcon
}
