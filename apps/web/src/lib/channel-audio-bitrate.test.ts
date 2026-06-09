import type { Channel } from '@syrnike13/api-types'
import { describe, expect, it } from 'vitest'

import {
  buildVoiceChannelAudioBitratePatch,
  channelAudioBitrateBps,
  channelAudioBitrateKbps,
  clampVoiceChannelAudioBitrateKbps,
  DEFAULT_VOICE_CHANNEL_AUDIO_BITRATE_KBPS,
} from './channel-audio-bitrate'

function voiceChannel(
  voice: NonNullable<Extract<Channel, { channel_type: 'TextChannel' }>['voice']>,
) {
  return {
    _id: 'channel-1',
    channel_type: 'TextChannel',
    server: 'server-1',
    name: 'Voice',
    description: null,
    icon: null,
    last_message_id: null,
    default_permissions: null,
    role_permissions: {},
    nsfw: false,
    voice,
    slowmode: null,
  } satisfies Extract<Channel, { channel_type: 'TextChannel' }>
}

describe('voice channel audio bitrate', () => {
  it('defaults legacy voice channels to 64 kbps', () => {
    expect(channelAudioBitrateKbps(voiceChannel({ max_users: null }))).toBe(
      DEFAULT_VOICE_CHANNEL_AUDIO_BITRATE_KBPS,
    )
    expect(channelAudioBitrateBps(voiceChannel({ max_users: null }))).toBe(
      64_000,
    )
  })

  it('clamps channel audio bitrate to the Discord-like 8-96 kbps range', () => {
    expect(clampVoiceChannelAudioBitrateKbps(4)).toBe(8)
    expect(clampVoiceChannelAudioBitrateKbps(48)).toBe(48)
    expect(clampVoiceChannelAudioBitrateKbps(128)).toBe(96)
  })

  it('builds a full voice patch without dropping max user settings', () => {
    expect(
      buildVoiceChannelAudioBitratePatch(
        voiceChannel({ max_users: 12, audio_bitrate_kbps: 64 }),
        96,
      ),
    ).toEqual({
      voice: {
        max_users: 12,
        audio_bitrate_kbps: 96,
      },
    })
  })
})
