import { describe, expect, it } from 'vitest'

import { resolveVoiceChannelClickAction } from './voice-channel-click'

describe('resolveVoiceChannelClickAction', () => {
  it('joins the voice channel when no voice session is active', () => {
    expect(
      resolveVoiceChannelClickAction({
        clickedChannelId: 'voice-a',
        voiceChannelId: null,
        voiceStatus: 'idle',
      }),
    ).toBe('join')
  })

  it('opens the current voice session screen on repeated click from another screen', () => {
    expect(
      resolveVoiceChannelClickAction({
        clickedChannelId: 'voice-a',
        voiceChannelId: 'voice-a',
        voiceStatus: 'connected',
      }),
    ).toBe('open')
  })

  it('opens the connecting voice session screen on repeated click', () => {
    expect(
      resolveVoiceChannelClickAction({
        clickedChannelId: 'voice-a',
        voiceChannelId: 'voice-a',
        voiceStatus: 'connecting',
      }),
    ).toBe('open')
  })

  it('keeps opening the current voice session screen on repeated click', () => {
    expect(
      resolveVoiceChannelClickAction({
        clickedChannelId: 'voice-a',
        voiceChannelId: 'voice-a',
        voiceStatus: 'connected',
      }),
    ).toBe('open')
  })

  it('switches voice without opening the target voice screen when another voice session is active', () => {
    expect(
      resolveVoiceChannelClickAction({
        clickedChannelId: 'voice-b',
        voiceChannelId: 'voice-a',
        voiceStatus: 'connected',
      }),
    ).toBe('join')
  })

  it('switches voice without opening the target voice screen while another voice join is connecting', () => {
    expect(
      resolveVoiceChannelClickAction({
        clickedChannelId: 'voice-b',
        voiceChannelId: 'voice-a',
        voiceStatus: 'connecting',
      }),
    ).toBe('join')
  })
})
