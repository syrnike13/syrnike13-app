import { describe, expect, it } from 'vitest'

import {
  baseVoiceIdentity,
  isDesktopNativeVoiceIdentity,
} from './native-voice-identity'

describe('native voice identity helpers', () => {
  it('maps operation-tagged native participants back to the base user', () => {
    const identity = 'user-1:desktop-native:op-join:screen'

    expect(baseVoiceIdentity(identity)).toBe('user-1')
    expect(isDesktopNativeVoiceIdentity(identity)).toBe(true)
    expect(identity.endsWith(':screen')).toBe(true)
  })
})
