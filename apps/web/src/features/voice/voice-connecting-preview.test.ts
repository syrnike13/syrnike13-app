import { describe, expect, it } from 'vitest'

import { createConnectingLocalVoiceState } from './voice-connecting-preview'

describe('createConnectingLocalVoiceState', () => {
  it('represents self-deafen as self-mute and self-deaf', () => {
    expect(
      createConnectingLocalVoiceState('user-a', {
        micEnabled: true,
        deafened: true,
      }),
    ).toMatchObject({
      self_mute: true,
      self_deaf: true,
    })
  })
})
