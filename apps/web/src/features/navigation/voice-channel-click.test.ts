import { describe, expect, it } from 'vitest'

import { resolveVoiceChannelClickAction } from './voice-channel-click'

describe('resolveVoiceChannelClickAction', () => {
  it('joins and opens the voice screen when no voice session is active', () => {
    expect(
      resolveVoiceChannelClickAction({
        clickedChannelId: 'voice-a',
        currentRouteChannelId: 'text-a',
        voiceChannelId: null,
        voiceStatus: 'idle',
      }),
    ).toBe('join-and-open')
  })

  it('opens the current voice session screen on repeated click from another screen', () => {
    expect(
      resolveVoiceChannelClickAction({
        clickedChannelId: 'voice-a',
        currentRouteChannelId: 'text-a',
        voiceChannelId: 'voice-a',
        voiceStatus: 'connected',
      }),
    ).toBe('open')
  })

  it('opens the connecting voice session screen on repeated click', () => {
    expect(
      resolveVoiceChannelClickAction({
        clickedChannelId: 'voice-a',
        currentRouteChannelId: 'text-a',
        voiceChannelId: 'voice-a',
        voiceStatus: 'connecting',
      }),
    ).toBe('open')
  })

  it('keeps opening the current voice session screen on repeated click', () => {
    expect(
      resolveVoiceChannelClickAction({
        clickedChannelId: 'voice-a',
        currentRouteChannelId: 'voice-a',
        voiceChannelId: 'voice-a',
        voiceStatus: 'connected',
      }),
    ).toBe('open')
  })

  it('switches voice and opens the target voice screen when another voice session is active', () => {
    expect(
      resolveVoiceChannelClickAction({
        clickedChannelId: 'voice-b',
        currentRouteChannelId: 'text-a',
        voiceChannelId: 'voice-a',
        voiceStatus: 'connected',
      }),
    ).toBe('join-and-open')
  })

  it('switches voice and opens the target voice screen while another voice join is connecting', () => {
    expect(
      resolveVoiceChannelClickAction({
        clickedChannelId: 'voice-b',
        currentRouteChannelId: 'text-a',
        voiceChannelId: 'voice-a',
        voiceStatus: 'connecting',
      }),
    ).toBe('join-and-open')
  })
})
