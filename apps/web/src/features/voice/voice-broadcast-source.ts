import {
  AppWindowIcon,
  GlobeIcon,
  MonitorIcon,
  VideoIcon,
  type AppIcon,
} from '#/components/icons'
import type { Translator } from '@syrnike13/ui/i18n'
import type { DesktopDisplayMediaSource } from '@syrnike13/platform'

export type ScreenShareSurface = 'monitor' | 'window' | 'browser'

export type ScreenShareBroadcastSource = {
  label: string
  surface: ScreenShareSurface
  appIconDataUrl?: string
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

export function screenShareSurfaceFallbackLabel(
  surface: ScreenShareSurface,
  t: Translator,
) {
  switch (surface) {
    case 'monitor':
      return t('broadcast.screen')
    case 'browser':
      return t('broadcast.browserTab')
    case 'window':
      return t('broadcast.window')
  }
}

export function readScreenShareBroadcastSource(
  track: MediaStreamTrack | null | undefined,
): ScreenShareBroadcastSource {
  const settings = track?.getSettings?.()
  const displaySurface: unknown = settings
    ? Reflect.get(settings, 'displaySurface')
    : undefined
  const surface = parseScreenShareSurface(
    typeof displaySurface === 'string' ? displaySurface : undefined,
  )
  return { label: track?.label?.trim() ?? '', surface }
}

export function rememberDesktopScreenShareBroadcastSource(
  source: Pick<DesktopDisplayMediaSource, 'name' | 'type'> &
    Partial<Pick<DesktopDisplayMediaSource, 'appIconDataUrl'>>,
) {
  const surface: ScreenShareSurface =
    source.type === 'screen' ? 'monitor' : 'window'
  desktopScreenShareSource = {
    label: source.name,
    surface,
    ...(source.appIconDataUrl
      ? { appIconDataUrl: source.appIconDataUrl }
      : undefined),
  }
}

export function desktopScreenShareSourceLabel(
  source: Pick<DesktopDisplayMediaSource, 'name' | 'type'>,
  t: Translator,
) {
  return screenShareBroadcastLabel(
    source.name,
    source.type === 'screen' ? 'monitor' : 'window',
    t,
  )
}

export function screenShareBroadcastLabel(
  value: string | null | undefined,
  surface: ScreenShareSurface,
  t: Translator,
) {
  const label = value?.trim()
  if (!label) return screenShareSurfaceFallbackLabel(surface, t)

  const internalScreen = /^screen:(\d+)(?::\d+)*$/i.exec(label)
  if (internalScreen) {
    return t('broadcast.screenNumbered', {
      number: Number(internalScreen[1]) + 1,
    })
  }

  const numberedScreen = /^(?:screen|экран)\s+(\d+)(?:\s+\([^)]*\))?$/i.exec(
    label,
  )
  if (numberedScreen) {
    return t('broadcast.screenNumbered', { number: numberedScreen[1] })
  }

  if (/^(?:window|web-contents):\d+(?::\d+)*$/i.test(label)) {
    return t('broadcast.window')
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
  t: Translator,
) {
  return track?.label?.trim() || t('broadcast.camera')
}

export function cameraBroadcastIcon(): AppIcon {
  return VideoIcon
}
