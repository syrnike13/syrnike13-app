import type { DesktopTrayVoiceState } from '@syrnike13/platform'

export const TRAY_ICON_ASSET_BY_STATE = {
  default: 'tray-default.png',
  'voice-idle': 'tray-voice-idle.png',
  'voice-speaking': 'tray-voice-speaking.png',
  'voice-muted': 'tray-voice-muted.png',
  'voice-deafened': 'tray-voice-deafened.png',
} as const satisfies Record<DesktopTrayVoiceState, string>

export function normalizeDesktopTrayVoiceState(
  value: unknown,
): DesktopTrayVoiceState {
  return typeof value === 'string' && value in TRAY_ICON_ASSET_BY_STATE
    ? (value as DesktopTrayVoiceState)
    : 'default'
}
