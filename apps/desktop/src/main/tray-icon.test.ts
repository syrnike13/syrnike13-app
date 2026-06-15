import { describe, expect, it } from 'vitest'

import {
  TRAY_ICON_ASSET_BY_STATE,
  normalizeDesktopTrayVoiceState,
} from './tray-icon'

describe('desktop tray icons', () => {
  it('maps every tray voice state to a dedicated asset', () => {
    expect(TRAY_ICON_ASSET_BY_STATE).toEqual({
      default: 'tray-default.png',
      'voice-idle': 'tray-voice-idle.png',
      'voice-speaking': 'tray-voice-speaking.png',
      'voice-muted': 'tray-voice-muted.png',
      'voice-deafened': 'tray-voice-deafened.png',
    })
  })

  it('normalizes untrusted renderer payloads to default', () => {
    expect(normalizeDesktopTrayVoiceState('voice-speaking')).toBe(
      'voice-speaking',
    )
    expect(normalizeDesktopTrayVoiceState('unknown')).toBe('default')
    expect(normalizeDesktopTrayVoiceState(null)).toBe('default')
  })
})
