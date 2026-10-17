import type { FloatingCorner } from '#/lib/floating-corner'
import type { VoiceStageMediaItem } from './voice-context'

export const MINI_PLAYER_CORNER_KEY = 'syrnike13.voice.streamMiniPlayerCorner'
export const MINI_PLAYER_WIDTH_KEY = 'syrnike13.voice.streamMiniPlayerWidth'
// Reserve the sidebar's user/voice controls and the chat composer respectively.
const SIDEBAR_VOICE_PANEL_BOTTOM_CLEARANCE = 192
const MESSAGE_COMPOSER_BOTTOM_CLEARANCE = 96
export type MiniPlayerViewport = { width: number; height: number }

export function miniPlayerWidth(
  requested: number,
  viewport: MiniPlayerViewport,
) {
  const max = Math.max(
    1,
    Math.min(480, viewport.width * 0.4, ((viewport.height - 64) * 16) / 9),
  )
  return Math.min(
    max,
    Math.max(Math.min(240, max), Number.isFinite(requested) ? requested : 320),
  )
}

export function clampMiniPlayerPosition(
  x: number,
  y: number,
  width: number,
  viewport: MiniPlayerViewport,
) {
  return {
    x: Math.max(8, Math.min(x, Math.max(8, viewport.width - width - 8))),
    y: Math.max(
      48,
      Math.min(y, Math.max(48, viewport.height - (width * 9) / 16 - 8)),
    ),
  }
}

export function miniPlayerCornerPosition(
  corner: FloatingCorner,
  width: number,
  viewport: MiniPlayerViewport,
) {
  const bottomClearance = corner.endsWith('left')
    ? SIDEBAR_VOICE_PANEL_BOTTOM_CLEARANCE
    : MESSAGE_COMPOSER_BOTTOM_CLEARANCE
  return clampMiniPlayerPosition(
    corner.endsWith('left') ? 16 : viewport.width - width - 16,
    corner.startsWith('top')
      ? 48
      : viewport.height - (width * 9) / 16 - bottomClearance,
    width,
    viewport,
  )
}

export function selectMiniPlayerStream(
  items: readonly VoiceStageMediaItem[],
  watchedIds: readonly string[],
  focusedId: string | null,
) {
  const watched = items.filter(
    (item) =>
      item.kind === 'screen' && !item.isLocal && watchedIds.includes(item.id),
  )
  return (
    watched.find((item) => item.id === focusedId) ??
    watched[0] ??
    items.find((item) => item.kind === 'screen' && item.isLocal) ??
    null
  )
}

export function miniPlayerVisible({
  hasStream,
  sessionChannelId,
  routeChannelId,
  stageMounted,
  popoutOpen,
  fullscreen,
}: {
  hasStream: boolean
  sessionChannelId: string | null
  routeChannelId: string | undefined
  stageMounted: boolean
  popoutOpen: boolean
  fullscreen: boolean
}) {
  return (
    hasStream &&
    sessionChannelId !== null &&
    (routeChannelId !== sessionChannelId || !stageMounted) &&
    !popoutOpen &&
    !fullscreen
  )
}
