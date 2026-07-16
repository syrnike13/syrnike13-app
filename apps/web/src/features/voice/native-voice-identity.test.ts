import { describe, expect, it } from 'vitest'

import {
  baseVoiceIdentity,
  isDesktopNativeVoiceIdentity,
  parseVoiceIdentity,
} from './native-voice-identity'

describe('native voice identity helpers', () => {
  it('maps operation-tagged native participants back to the base user', () => {
    const identity =
      'voice:v1|windows_native|client-1|epoch-1|voice-op-1|user-1'

    expect(baseVoiceIdentity(identity)).toBe('user-1')
    expect(isDesktopNativeVoiceIdentity(identity)).toBe(true)
    expect(parseVoiceIdentity(identity)).toMatchObject({
      rtcEngine: 'windows_native',
      operationId: 'voice-op-1',
      userId: 'user-1',
    })
  })

  it('maps operation-tagged browser participants back to the base user', () => {
    expect(
      baseVoiceIdentity(
        'voice:v1|web|browser-1|epoch-1|voice-op-550e8400-e29b-41d4-a716-446655440000|user-1',
      ),
    ).toBe('user-1')
  })
})
