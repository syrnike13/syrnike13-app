import {
  DesktopTrayVoiceStateSchema,
  type DesktopTrayVoiceState,
} from '@syrnike13/platform'
import { Option, Schema } from 'effect'

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
  return Option.getOrElse(
    Schema.decodeUnknownOption(DesktopTrayVoiceStateSchema)(value),
    () => 'default',
  )
}
