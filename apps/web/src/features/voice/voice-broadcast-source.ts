import {
  AppWindowIcon,
  GlobeIcon,
  MonitorIcon,
  VideoIcon,
  type AppIcon,
} from '#/components/icons'

export type ScreenShareSurface = 'monitor' | 'window' | 'browser'

export type ScreenShareBroadcastSource = {
  label: string
  surface: ScreenShareSurface
}

type DisplaySurfaceSettings = MediaTrackSettings & {
  displaySurface?: string
}

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
      return 'Весь экран'
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
  const label = track?.label?.trim() || screenShareSurfaceFallbackLabel(surface)
  return { label, surface }
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
